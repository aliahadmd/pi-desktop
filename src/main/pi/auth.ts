/**
 * AuthService — app-level model/auth management (chapter 6).
 *
 * Owns THE shared ModelRuntime instance used by every SDK session, so API keys
 * set here apply to all sessions (pi's setRuntimeApiKey is runtime-scoped and
 * not persisted by pi — we re-apply stored keys on every boot).
 *
 * Key storage: Electron safeStorage (Keychain-backed) → encrypted blob in
 * app_settings. Keys never reach the renderer unmasked and never appear in logs.
 */
import { safeStorage } from "electron";
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ModelRuntime, SettingsManager, getAgentDir } from "@earendil-works/pi-coding-agent";
import type { AuthInteraction, AuthPrompt } from "@earendil-works/pi-ai";
import type { ModelCatalogEntry, ProviderAuthInfo } from "../../shared/pi";
import { toJson } from "../../shared/pi";
import { describeError } from "./backend";
import type { IpcRouter } from "../ipc/router";
import type { RendererEventBus } from "../ipc/events";

const KEYS_SETTING = "auth.apiKeys"; // { [providerId]: base64 encrypted }

interface LoginFlow {
	id: string;
	providerId: string;
	resolvePrompt(value: string): void;
	rejectPrompt(error: Error): void;
}

export class AuthService {
	private runtime: ModelRuntime | null = null;
	private settingsManager: SettingsManager | null = null;
	private readonly bus: RendererEventBus;
	private readonly getStored: (key: string) => unknown;
	private readonly setStored: (key: string, value: unknown) => void;
	private readonly log: (level: "info" | "warn" | "error", message: string) => void;
	private readonly onScopedModelsChanged: (
		models: Array<{ provider: string; modelId: string; thinkingLevel?: string }>
	) => void;
	private loginFlows = new Map<string, LoginFlow>();

	constructor(deps: {
		bus: RendererEventBus;
		getStored: (key: string) => unknown;
		setStored: (key: string, value: unknown) => void;
		log: (level: "info" | "warn" | "error", message: string) => void;
		onScopedModelsChanged: (
			models: Array<{ provider: string; modelId: string; thinkingLevel?: string }>
		) => void;
	}) {
		this.bus = deps.bus;
		this.getStored = deps.getStored;
		this.setStored = deps.setStored;
		this.log = deps.log;
		this.onScopedModelsChanged = deps.onScopedModelsChanged;
	}

	async start(): Promise<void> {
		this.runtime = await ModelRuntime.create({ allowModelNetwork: true, modelRefreshTimeoutMs: 15_000 });
		this.settingsManager = SettingsManager.create(process.cwd(), getAgentDir());
		await this.applyStoredKeys();
	}

	async stop(): Promise<void> {
		for (const [, flow] of this.loginFlows) {
			flow.rejectPrompt(new Error("app shutting down"));
		}
		this.loginFlows.clear();
		await this.settingsManager?.flush().catch(() => {});
	}

	/** Shared runtime for all SDK sessions. */
	getRuntime(): ModelRuntime | null {
		return this.runtime;
	}

	registerHandlers(router: IpcRouter): void {
		router.handle("auth.providers", async () => {
			return { providers: await this.listProviders() };
		});
		router.handle("auth.models", async (req) => {
			return { models: await this.listModels(req.provider) };
		});
		router.handle("auth.set_key", async (req) => {
			await this.setApiKey(req.providerId, req.key);
			return null;
		});
		router.handle("auth.remove_key", async (req) => {
			await this.removeApiKey(req.providerId);
			return null;
		});
		router.handle("auth.login", async (req) => {
			await this.startLogin(req.providerId, req.authType);
			return null;
		});
		router.handle("auth.respond_login", async (req) => {
			const flow = this.loginFlows.get(req.loginId);
			if (flow !== undefined) {
				this.loginFlows.delete(req.loginId);
				flow.resolvePrompt(req.value);
			}
			return null;
		});
		router.handle("auth.logout", async (req) => {
			if (this.runtime === null) throw new Error("auth not ready");
			await this.runtime.logout(req.providerId);
			return null;
		});
		router.handle("models.json.get", () => {
			const agentDir = getAgentDir();
			const modelsPath = path.join(agentDir, "models.json");
			let content: unknown = { providers: {} };
			if (existsSync(modelsPath)) {
				try {
					content = JSON.parse(readFileSync(modelsPath, "utf8"));
				} catch (error) {
					throw new Error(`models.json is not valid JSON: ${describeError(error)}`);
				}
			}
			return toJson(content);
		});
		router.handle("models.json.save", (req) => {
			const parsed: unknown = JSON.parse(req.content);
			// Shape validation before overwriting pi's file.
			if (
				typeof parsed !== "object" ||
				parsed === null ||
				typeof (parsed as { providers?: unknown }).providers !== "object" ||
				(parsed as { providers?: unknown }).providers === null
			) {
				throw new Error("models.json must contain a non-empty 'providers' object");
			}
			const providers = (parsed as { providers: Record<string, unknown> }).providers;
			for (const [id, provider] of Object.entries(providers)) {
				if (typeof provider !== "object" || provider === null) {
					throw new Error(`providers.${id} must be an object`);
				}
				const p = provider as { baseUrl?: unknown; api?: unknown; models?: unknown };
				if (typeof p.baseUrl !== "string" || p.baseUrl.length === 0) {
					throw new Error(`providers.${id}.baseUrl must be a non-empty string`);
				}
				if (typeof p.api !== "string" || p.api.length === 0) {
					throw new Error(`providers.${id}.api must be a non-empty string`);
				}
				if (!Array.isArray(p.models) || p.models.length === 0) {
					throw new Error(`providers.${id}.models must be a non-empty array`);
				}
			}
			const agentDir = getAgentDir();
			mkdirSync(agentDir, { recursive: true });
			const target = path.join(agentDir, "models.json");
			// Atomic write with one-generation backup.
			if (existsSync(target)) {
				copyFileSync(target, target + ".bak");
			}
			const tmp = target + ".tmp";
			writeFileSync(tmp, JSON.stringify(parsed, null, 2) + "\n", "utf8");
			renameSync(tmp, target);
			return null;
		});
		router.handle("session.scoped_models.get", () => {
			if (this.settingsManager === null) return { models: [] };
			void this.settingsManager;
			const raw = this.getStored("scopedModels");
			const models = Array.isArray(raw)
				? (raw as Array<{ provider: string; modelId: string; thinkingLevel?: string }>)
				: [];
			return { models };
		});
		router.handle("session.scoped_models.set", (req) => {
			this.setStored("scopedModels", req.models);
			this.onScopedModelsChanged(req.models);
			return null;
		});
		router.handle("packages.list", () => {
			const pm = this.makePackageManager();
			return { packages: pm.listConfiguredPackages() };
		});
		router.handle("packages.install", async (req) => {
			const pm = this.makePackageManager();
			const progress: string[] = [];
			pm.setProgressCallback((event) => {
				progress.push(`[${event.type}/${event.action}] ${event.message ?? event.source}`);
			});
			try {
				await pm.installAndPersist(req.source);
			} finally {
				pm.setProgressCallback(undefined);
			}
			return { progress };
		});
		router.handle("packages.remove", async (req) => {
			const pm = this.makePackageManager();
			await pm.removeAndPersist(req.source);
			return null;
		});
		router.handle("pi.config.write_trust", (req) => {
			const parsed: unknown = JSON.parse(req.content);
			if (typeof parsed !== "object" || parsed === null) {
				throw new Error("trust content must be a JSON object");
			}
			const agentDir = getAgentDir();
			mkdirSync(agentDir, { recursive: true });
			writeFileSync(
				path.join(agentDir, "trust.json"),
				JSON.stringify(parsed, null, 2) + "\n",
				"utf8"
			);
			return null;
		});
		router.handle("pi.config.read", (req) => {
			const agentDir = getAgentDir();
			const fileName = req.name === "trust" ? "trust.json" : "keybindings.json";
			const filePath = path.join(agentDir, fileName);
			if (!existsSync(filePath)) return toJson({});
			try {
				return toJson(JSON.parse(readFileSync(filePath, "utf8")));
			} catch (error) {
				throw new Error(`${fileName} is not valid JSON: ${describeError(error)}`);
			}
		});
		router.handle("pi.settings.get", () => {
			if (this.settingsManager === null) return toJson({});
			const s = this.settingsManager.getGlobalSettings();
			return toJson(s);
		});
		router.handle("pi.settings.set", (req) => {
			this.setPiSetting(req.key, req.value);
			return null;
		});
		router.handle("session.default_model", async (req) => {
			if (this.settingsManager === null) throw new Error("settings not ready");
			this.settingsManager.setDefaultModelAndProvider(req.provider, req.modelId);
			await this.settingsManager.flush();
			return null;
		});
	}

	// ---------------------------------------------------------------------------
	// Provider / model listing
	// ---------------------------------------------------------------------------

	async listProviders(): Promise<ProviderAuthInfo[]> {
		if (this.runtime === null) return [];
		const providers = this.runtime.getProviders();
		const out: ProviderAuthInfo[] = [];
		for (const provider of providers) {
			try {
				const check = await this.runtime.checkAuth(provider.id);
				out.push({
					id: provider.id,
					name: provider.name,
					configured: this.runtime.hasConfiguredAuth(provider.id),
					authType: check?.type ?? "none",
					...(check?.source !== undefined ? { source: check.source } : {}),
					usingOAuth: this.runtime.isUsingOAuth(provider.id),
					usingSubscription: this.runtime.isUsingSubscription(provider.id),
					modelCount: this.runtime.getModels(provider.id).length,
				});
			} catch (error) {
				out.push({
					id: provider.id,
					name: provider.name,
					configured: false,
					authType: "none",
					usingOAuth: false,
					usingSubscription: false,
					modelCount: 0,
					error: describeError(error),
				});
			}
		}
		return out;
	}

	async listModels(providerId?: string): Promise<ModelCatalogEntry[]> {
		if (this.runtime === null) return [];
		const models = this.runtime.getModels(providerId);
		const providerName = new Map(
			this.runtime.getProviders().map((p) => [p.id, p.name as string])
		);
		return models.map((m) => ({
			provider: String(m.provider),
			providerName: providerName.get(String(m.provider)) ?? String(m.provider),
			id: m.id,
			name: String(m.name ?? m.id),
			contextWindow: m.contextWindow,
			maxTokens: m.maxTokens,
			reasoning: m.reasoning === true,
			input: [...m.input],
			inputCostPerMtok: m.cost?.input ?? null,
			outputCostPerMtok: m.cost?.output ?? null,
		}));
	}

	// ---------------------------------------------------------------------------
	// API keys (safeStorage-encrypted)
	// ---------------------------------------------------------------------------

	async setApiKey(providerId: string, key: string): Promise<void> {
		if (this.runtime === null) throw new Error("auth not ready");
		await this.runtime.setRuntimeApiKey(providerId, key);
		this.storeKey(providerId, key);
		this.log("info", `api key stored for ${providerId}`);
	}

	async removeApiKey(providerId: string): Promise<void> {
		if (this.runtime === null) throw new Error("auth not ready");
		await this.runtime.removeRuntimeApiKey(providerId);
		const keys = this.readKeys();
		delete keys[providerId];
		this.setStored(KEYS_SETTING, keys);
	}

	/** Re-apply stored keys to the runtime (boot + after import). */
	async applyStoredKeys(): Promise<void> {
		if (this.runtime === null) return;
		const keys = this.readKeys();
		for (const [providerId, encrypted] of Object.entries(keys)) {
			const key = this.decrypt(encrypted);
			if (key === null) continue;
			try {
				await this.runtime.setRuntimeApiKey(providerId, key);
			} catch (error) {
				this.log("warn", `failed to apply key for ${providerId}: ${describeError(error)}`);
			}
		}
	}

	hasAnyConfiguredAuth(): boolean {
		if (this.runtime === null) return true; // don't nag if unavailable
		return Object.keys(this.readKeys()).length > 0
			? true
			: this.runtime.getProviders().some((p) => this.runtime?.hasConfiguredAuth(p.id) === true);
	}

	private readKeys(): Record<string, string> {
		const raw = this.getStored(KEYS_SETTING);
		return typeof raw === "object" && raw !== null ? (raw as Record<string, string>) : {};
	}

	private storeKey(providerId: string, key: string): void {
		if (!safeStorage.isEncryptionAvailable()) {
			throw new Error("secure storage unavailable (Keychain)");
		}
		const encrypted = safeStorage.encryptString(key).toString("base64");
		const keys = this.readKeys();
		keys[providerId] = encrypted;
		this.setStored(KEYS_SETTING, keys);
	}

	private decrypt(encrypted: string): string | null {
		try {
			return safeStorage.decryptString(Buffer.from(encrypted, "base64"));
		} catch (error) {
			this.log("warn", `failed to decrypt stored key: ${describeError(error)}`);
			return null;
		}
	}

	// ---------------------------------------------------------------------------
	// Interactive login (api_key prompt flow / OAuth with browser + code paste)
	// ---------------------------------------------------------------------------

	async startLogin(providerId: string, authType: "api_key" | "oauth"): Promise<void> {
		if (this.runtime === null) throw new Error("auth not ready");
		const loginId = `login-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		const interaction: AuthInteraction = {
			prompt: (prompt: AuthPrompt) =>
				new Promise<string>((resolve, reject) => {
					const timer = setTimeout(() => {
						this.loginFlows.delete(loginId);
						reject(new Error("login prompt timed out (5 minutes)"));
					}, 5 * 60_000);
					this.loginFlows.set(loginId, {
						id: loginId,
						providerId,
						resolvePrompt: (value: string) => {
							clearTimeout(timer);
							resolve(value);
						},
						rejectPrompt: (error: Error) => {
							clearTimeout(timer);
							reject(error);
						},
					});
					this.bus.send({
						type: "auth_prompt",
						loginId,
						providerId,
						prompt: toJson(prompt) as never,
					});
				}),
			notify: (event) => {
				if (event.type === "auth_url") {
					void import("electron").then(({ shell }) => void shell.openExternal(event.url));
				}
				this.bus.send({
					type: "auth_notify",
					loginId,
					providerId,
					event: toJson(event) as never,
				});
			},
		};
		try {
			await this.runtime.login(providerId, authType, interaction);
			this.log("info", `login complete for ${providerId}`);
		} catch (error) {
			this.log("warn", `login failed for ${providerId}: ${describeError(error)}`);
			throw error;
		} finally {
			// Reject any dangling prompt so the renderer modal closes.
			const flow = this.loginFlows.get(loginId);
			if (flow !== undefined) {
				this.loginFlows.delete(loginId);
				flow.rejectPrompt(new Error("login flow ended"));
			}
		}
	}

	private makePackageManager(): import("@earendil-works/pi-coding-agent").DefaultPackageManager {
		if (this.settingsManager === null) throw new Error("settings not ready");
		const { DefaultPackageManager } =
			require("@earendil-works/pi-coding-agent") as typeof import("@earendil-works/pi-coding-agent");
		return new DefaultPackageManager({
			cwd: process.cwd(),
			agentDir: getAgentDir(),
			settingsManager: this.settingsManager,
		});
	}

	// ---------------------------------------------------------------------------
	// Pi settings editor (global settings.json via SettingsManager)
	// ---------------------------------------------------------------------------

	private setPiSetting(key: string, valueJson: string): void {
		const sm = this.settingsManager;
		if (sm === null) throw new Error("settings not ready");
		const value: unknown = JSON.parse(valueJson);
		switch (key) {
			case "defaultProvider": {
				const provider = String(value);
				if (provider.trim().length === 0) throw new Error("defaultProvider must be a non-empty string");
				sm.setDefaultProvider(provider.trim());
				break;
			}
			case "defaultModel": {
				const modelId = String(value);
				if (modelId.trim().length === 0) throw new Error("defaultModel must be a non-empty string");
				sm.setDefaultModel(modelId.trim());
				break;
			}
			case "defaultProviderModel":
			case "defaultModelAndProvider": {
				const obj = value as { provider: string; modelId: string };
				sm.setDefaultModelAndProvider(obj.provider, obj.modelId);
				break;
			}
			case "defaultThinkingLevel": {
				const allowed = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
				if (typeof value !== "string" || !allowed.includes(value)) {
					throw new Error(`defaultThinkingLevel must be one of: ${allowed.join(", ")}`);
				}
				sm.setDefaultThinkingLevel(value as never);
				break;
			}
			case "hideThinkingBlock":
				sm.setHideThinkingBlock(value === true);
				break;
			case "compactionEnabled":
				sm.setCompactionEnabled(value === true);
				break;
			case "retryEnabled":
				sm.setRetryEnabled(value === true);
				break;
			default:
				throw new Error(`unsupported setting key: ${key}`);
		}
		void sm.flush().catch((error: unknown) => {
			this.log("warn", `settings flush failed: ${describeError(error)}`);
		});
	}

	getAgentDir(): string {
		return getAgentDir();
	}
}
