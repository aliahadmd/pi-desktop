/**
 * Audit 6 M-8: extension/settings diagnostics must reach the renderer as
 * backend_warning events instead of vanishing.
 *
 *  - RPC: upstream emits `extension_error` events; the backend maps them.
 *  - SDK: session creation collects services.diagnostics + extension load
 *    errors (previously `diagnostics: []` was hardcoded) and forwards them.
 *
 * The SDK half mocks @earendil-works/pi-coding-agent at the module boundary —
 * the test drives the real SdkPiBackend.start() factory path.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { PiEvent } from "../../src/shared/pi";
import { mapRpcEventToPiEvent } from "../../src/main/pi/rpc-backend";
import { collectStartupDiagnostics } from "../../src/main/pi/sdk-backend";

// ---------------------------------------------------------------------------
// RPC half: pure event mapping
// ---------------------------------------------------------------------------

describe("RPC extension_error mapping (audit 6 M-8)", () => {
	it("maps to backend_warning with path, event, and error", () => {
		const event = mapRpcEventToPiEvent({
			type: "extension_error",
			extensionPath: "/home/u/.pi/agent/extensions/broken.ts",
			event: "tool_call",
			error: "boom",
		});
		expect(event).not.toBeNull();
		expect(event?.type).toBe("backend_warning");
		if (event?.type !== "backend_warning") throw new Error("unreachable");
		expect(event.reason).toContain("/home/u/.pi/agent/extensions/broken.ts");
		expect(event.reason).toContain("tool_call");
		expect(event.reason).toContain("boom");
	});

	it("tolerates missing optional fields", () => {
		const event = mapRpcEventToPiEvent({ type: "extension_error" });
		expect(event?.type).toBe("backend_warning");
		if (event?.type !== "backend_warning") throw new Error("unreachable");
		expect(event.reason).toContain("unknown");
	});
});

// ---------------------------------------------------------------------------
// collectStartupDiagnostics: pure collection logic
// ---------------------------------------------------------------------------

describe("collectStartupDiagnostics (audit 6 M-8)", () => {
	it("merges services diagnostics with extension load errors", () => {
		const services = {
			diagnostics: [{ type: "warning" as const, message: "flag thing" }],
			resourceLoader: {
				getExtensions: () => ({
					extensions: [],
					errors: [{ path: "/ext/broken.ts", error: "SyntaxError: bad" }],
				}),
			},
		};
		const out = collectStartupDiagnostics(services as never);
		expect(out).toEqual([
			{ type: "warning", message: "flag thing" },
			{
				type: "error",
				message: "Extension failed to load: /ext/broken.ts: SyntaxError: bad",
			},
		]);
	});
});

// ---------------------------------------------------------------------------
// SDK half: drive start() with a mocked pi-coding-agent module
// ---------------------------------------------------------------------------

const mocks = vi.hoisted(() => {
	const fakeSession = {
		bindExtensions: vi.fn(async () => {}),
		subscribe: vi.fn(() => () => {}),
		setSessionName: vi.fn(),
	};
	const fakeServices = {
		cwd: "/tmp/proj",
		agentDir: "/tmp/agent",
		modelRuntime: {},
		settingsManager: {},
		resourceLoader: {
			getExtensions: () => ({
				extensions: [],
				errors: [{ path: "/ext/broken.ts", error: "SyntaxError: unexpected token" }],
			}),
		},
		diagnostics: [{ type: "warning", message: "unknown extension flag: --wat" }],
	};
	/** Diagnostics the runtime factory returned (captured by the mock). */
	const capturedDiagnostics: unknown[] = [];
	return { fakeSession, fakeServices, capturedDiagnostics };
});

vi.mock("@earendil-works/pi-coding-agent", () => ({
	createAgentSessionServices: vi.fn(async () => mocks.fakeServices),
	createAgentSessionFromServices: vi.fn(async () => ({ session: mocks.fakeSession })),
	createAgentSessionRuntime: vi.fn(
		async (
			factory: (opts: unknown) => Promise<{ session: unknown; diagnostics: unknown[] }>,
			opts: { cwd: string; agentDir: string; sessionManager: unknown }
		) => {
			const result = await factory(opts);
			mocks.capturedDiagnostics.push(result.diagnostics);
			return {
				session: result.session,
				diagnostics: result.diagnostics,
				setRebindSession: vi.fn(),
				dispose: vi.fn(async () => {}),
			};
		}
	),
	getAgentDir: () => "/tmp/agent",
	hasTrustRequiringProjectResources: () => false,
	ProjectTrustStore: class {
		get(): null {
			return null;
		}
		set(): void {}
	},
	ModelRuntime: { create: vi.fn(async () => ({})) },
	SessionManager: {
		create: vi.fn(() => ({})),
		open: vi.fn(() => ({})),
		inMemory: vi.fn(() => ({})),
	},
	SettingsManager: { create: vi.fn(() => ({})) },
}));

describe("SDK startup diagnostics (audit 6 M-8)", () => {
	let events: PiEvent[];
	let backend: import("../../src/main/pi/sdk-backend").SdkPiBackend;

	beforeAll(async () => {
		events = [];
		const { SdkPiBackend } = await import("../../src/main/pi/sdk-backend");
		backend = SdkPiBackend.create({
			cwd: "/tmp/proj",
			onEvent: (event) => events.push(event),
			onDied: () => {},
		});
		await backend.start();
		// Emission is deferred one macrotask so the session.create response (and
		// the renderer's session registration) precedes the warnings.
		await new Promise((resolve) => setTimeout(resolve, 30));
	});

	afterAll(async () => {
		await backend.dispose();
	});

	it("forwards services diagnostics and extension errors as backend_warning", () => {
		const reasons = events
			.filter((e) => e.type === "backend_warning")
			.map((e) => (e.type === "backend_warning" ? e.reason : ""));
		expect(reasons).toEqual([
			"[warning] unknown extension flag: --wat",
			"[error] Extension failed to load: /ext/broken.ts: SyntaxError: unexpected token",
		]);
	});

	it("returns the collected diagnostics to the runtime (no more hardcoded [])", () => {
		expect(mocks.capturedDiagnostics).toEqual([
			[
				{ type: "warning", message: "unknown extension flag: --wat" },
				{
					type: "error",
					message: "Extension failed to load: /ext/broken.ts: SyntaxError: unexpected token",
				},
			],
		]);
	});
});
