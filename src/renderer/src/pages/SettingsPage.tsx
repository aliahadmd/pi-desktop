/**
 * Settings page (phase 7): two-pane layout — a dedicated section sidebar on
 * the left and the active section's controls on the right.
 *
 * Sections group related settings:
 *   General   — pi defaults (provider/model/thinking), scoped models
 *   Appearance— theme presets, UI scale, window transparency
 *   Safety    — default permission mode
 *   Sound     — sound effects toggle
 *   Packages  — package marketplace / installed skills
 */
import { useCallback, useEffect, useState } from "react";
import {
	piThinkingLevels,
	permissionModes,
	PERMISSION_MODE_LABEL,
	DEFAULT_PERMISSION_MODE,
	isPermissionMode,
	type PermissionMode,
} from "../../../shared/pi";
import { MODE_DESCRIPTION } from "../components/chat/ModePicker";
import { THEME_PRESETS } from "../../../shared/theme";
import { SCALES } from "../../../shared/display";
import {
	Laptop,
	Package,
	Settings2,
	ShieldCheck,
	Volume2,
} from "lucide-react";
import { ScopedModelsEditor } from "./ScopedModelsEditor";
import { PackagesPanel } from "./PackagesPanel";

interface PiSettings {
	defaultProvider?: string;
	defaultModel?: string;
	defaultThinkingLevel?: string;
	hideThinkingBlock?: boolean;
	compaction?: { enabled?: boolean };
	retry?: { enabled?: boolean; maxRetries?: number };
	[key: string]: unknown;
}

const SECTIONS = [
	{ id: "general", label: "General", icon: Settings2 },
	{ id: "appearance", label: "Appearance", icon: Laptop },
	{ id: "safety", label: "Safety", icon: ShieldCheck },
	{ id: "sound", label: "Sound", icon: Volume2 },
	{ id: "packages", label: "Packages", icon: Package },
] as const;

type SectionId = (typeof SECTIONS)[number]["id"];

export function SettingsPage({
	themeId,
	onChangeTheme,
	uiScale,
	onChangeUiScale,
	transparency,
	onChangeTransparency,
}: {
	themeId: string;
	onChangeTheme(next: string): void;
	uiScale: number;
	onChangeUiScale(next: number): void;
	transparency: boolean;
	onChangeTransparency(on: boolean): void;
}): React.JSX.Element {
	const [section, setSection] = useState<SectionId>("general");
	const [settings, setSettings] = useState<PiSettings>({});
	const [saving, setSaving] = useState(false);
	const [saved, setSaved] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const load = useCallback(async (): Promise<void> => {
		const result = await window.piDesktop.invoke({ type: "pi.settings.get" });
		if (result.ok) setSettings(result.data as PiSettings);
	}, []);

	useEffect(() => {
		void load();
	}, [load]);

	async function save(key: string, value: unknown): Promise<void> {
		setSaving(true);
		setError(null);
		try {
			const r = await window.piDesktop.invoke({
				type: "pi.settings.set",
				key,
				value: JSON.stringify(value),
			});
			if (!r.ok) {
				setError(r.error.message);
				return;
			}
			setSaved(true);
			await load();
			setTimeout(() => setSaved(false), 2000);
		} finally {
			setSaving(false);
		}
	}

	return (
		<div className="flex h-full" data-testid="settings-layout">
			{/* Dedicated settings sidebar: section navigation. */}
			<nav
				className="flex w-44 shrink-0 flex-col gap-0.5 overflow-y-auto border-r border-neutral-800 p-3"
				data-testid="settings-sidebar"
			>
				<div className="mb-2 px-2 text-[10px] tracking-wide text-app-faint uppercase">
					Settings
				</div>
				{SECTIONS.map(({ id, label, icon: Icon }) => (
					<button
						key={id}
						type="button"
						data-testid={`settings-nav-${id}`}
						onClick={() => setSection(id)}
						className={`flex items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-xs transition-standard ${
							section === id
								? "bg-app-accent/15 font-medium text-app-text ring-1 ring-inset ring-app-accent/30"
								: "text-app-muted hover:bg-neutral-800 hover:text-app-text"
						}`}
					>
						<Icon size={14} strokeWidth={1.75} />
						{label}
					</button>
				))}
			</nav>

			{/* Active section content */}
			<div className="h-full min-w-0 flex-1 overflow-y-auto p-6">
				<div className="max-w-xl">
					{section === "general" && (
						<GeneralSection
							settings={settings}
							setSettings={setSettings}
							error={error}
							saved={saved}
							saving={saving}
							onSave={save}
						/>
					)}
					{section === "appearance" && (
						<AppearanceSection
							themeId={themeId}
							onChangeTheme={onChangeTheme}
							uiScale={uiScale}
							onChangeUiScale={onChangeUiScale}
							transparency={transparency}
							onChangeTransparency={onChangeTransparency}
						/>
					)}
					{section === "safety" && <SafetySection />}
					{section === "sound" && <SoundSection />}
					{section === "packages" && <PackagesPanel />}
				</div>
			</div>
		</div>
	);
}

function SectionHeader({ title, hint }: { title: string; hint: string }): React.JSX.Element {
	return (
		<div className="mb-5">
			<h2 className="text-base font-semibold text-neutral-100">{title}</h2>
			<p className="mt-1 text-xs text-neutral-500">{hint}</p>
		</div>
	);
}

function GeneralSection({
	settings,
	setSettings,
	error,
	saved,
	saving,
	onSave,
}: {
	settings: PiSettings;
	setSettings(updater: (prev: PiSettings) => PiSettings): void;
	error: string | null;
	saved: boolean;
	saving: boolean;
	onSave(key: string, value: unknown): Promise<void>;
}): React.JSX.Element {
	return (
		<div>
			<SectionHeader
				title="General"
				hint="Edits pi's global settings (~/.pi/agent/settings.json). Project settings stay in each repo's .pi/settings.json."
			/>
			{error !== null && (
				<div className="mb-3 rounded border border-danger/40 bg-danger-soft/50 px-3 py-2 text-xs text-red-300">
					{error}
				</div>
			)}
			{saved && (
				<div className="mb-3 rounded border border-success/40 bg-success-soft px-3 py-2 text-xs text-success">
					Saved.
				</div>
			)}
			<div className="flex flex-col gap-5">
				<SettingRow label="Default provider" hint="Used when no model is restored from a session">
					<input
						value={settings.defaultProvider ?? ""}
						onChange={(e) => setSettings((s) => ({ ...s, defaultProvider: e.target.value }))}
						onBlur={(e) => void onSave("defaultProvider", e.target.value)}
						placeholder="anthropic"
						className="w-48 rounded border border-neutral-700 bg-neutral-900 px-3 py-1.5 text-xs outline-none focus:border-blue-500"
					/>
				</SettingRow>

				<SettingRow label="Default model" hint="Model id, e.g. claude-sonnet-4-5">
					<input
						value={settings.defaultModel ?? ""}
						onChange={(e) => setSettings((s) => ({ ...s, defaultModel: e.target.value }))}
						onBlur={(e) => void onSave("defaultModel", e.target.value)}
						placeholder="model id"
						className="w-48 rounded border border-neutral-700 bg-neutral-900 px-3 py-1.5 text-xs outline-none focus:border-blue-500"
					/>
				</SettingRow>

				<SettingRow label="Default thinking level">
					<select
						value={settings.defaultThinkingLevel ?? "medium"}
						onChange={(e) => void onSave("defaultThinkingLevel", e.target.value)}
						className="rounded border border-neutral-700 bg-neutral-900 px-3 py-1.5 text-xs outline-none focus:border-blue-500"
					>
						{piThinkingLevels.map((level) => (
							<option key={level} value={level}>
								{level}
							</option>
						))}
					</select>
				</SettingRow>

				<SettingRow label="Hide thinking blocks" hint="Collapse reasoning output in transcripts">
					<Toggle
						checked={settings.hideThinkingBlock === true}
						onChange={(v) => {
							setSettings((s) => ({ ...s, hideThinkingBlock: v }));
							void onSave("hideThinkingBlock", v);
						}}
					/>
				</SettingRow>

				<SettingRow label="Auto-compaction" hint="Summarize context automatically when nearly full">
					<Toggle
						checked={settings.compaction?.enabled !== false}
						onChange={(v) => {
							setSettings((prev) => ({
								...prev,
								compaction: { ...prev.compaction, enabled: v },
							}));
							void onSave("compactionEnabled", v);
						}}
					/>
				</SettingRow>

				<SettingRow label="Auto-retry" hint="Retry transient provider errors automatically">
					<Toggle
						checked={settings.retry?.enabled !== false}
						onChange={(v) => {
							setSettings((prev) => ({ ...prev, retry: { ...prev.retry, enabled: v } }));
							void onSave("retryEnabled", v);
						}}
					/>
				</SettingRow>
			</div>

			<div className="mt-8 border-t border-neutral-800 pt-5">
				<ScopedModelsEditor />
			</div>

			<div className="mt-8 border-t border-neutral-800 pt-4 text-[10px] text-neutral-600">
				{saving ? "Saving…" : "Changes write through pi's SettingsManager."}
			</div>
		</div>
	);
}

function AppearanceSection({
	themeId,
	onChangeTheme,
	uiScale,
	onChangeUiScale,
	transparency,
	onChangeTransparency,
}: {
	themeId: string;
	onChangeTheme(next: string): void;
	uiScale: number;
	onChangeUiScale(next: number): void;
	transparency: boolean;
	onChangeTransparency(on: boolean): void;
}): React.JSX.Element {
	return (
		<div>
			<SectionHeader title="Appearance" hint="Themes, zoom level, and window effects." />
			<div className="flex flex-col gap-5">
				<SettingRow
					label="Theme"
					hint="Applies immediately and persists. Code blocks follow the theme."
				>
					<div className="flex flex-wrap gap-2">
						{THEME_PRESETS.map((p) => (
							<button
								key={p.id}
								type="button"
								data-testid={`theme-${p.id}`}
								onClick={() => onChangeTheme(p.id)}
								className={`flex items-center gap-2 rounded-lg border px-3 py-1.5 text-xs transition-standard ${
									themeId === p.id
										? "border-app-accent bg-app-accent/10 text-app-text"
										: "border-app-border text-app-muted hover:text-app-text"
								}`}
							>
								<span className="flex overflow-hidden rounded-sm" aria-hidden="true">
									<span className="h-4 w-2" style={{ background: p.vars.bg }} />
									<span className="h-4 w-2" style={{ background: p.vars.surface2 }} />
									<span className="h-4 w-2" style={{ background: p.vars.accent }} />
									<span className="h-4 w-2" style={{ background: p.vars.text }} />
								</span>
								{p.label}
							</button>
						))}
					</div>
				</SettingRow>

				<SettingRow label="UI scale" hint="Zoom the whole interface. Applies immediately.">
					<div className="flex gap-1" data-testid="ui-scale-group">
						{SCALES.map((s) => (
							<button
								key={s}
								type="button"
								data-testid={`ui-scale-${String(Math.round(s * 100))}`}
								onClick={() => onChangeUiScale(s)}
								className={`rounded px-2.5 py-1 text-xs transition-standard ${
									uiScale === s
										? "bg-app-accent/20 text-app-text ring-1 ring-inset ring-app-accent/50"
										: "text-app-muted hover:bg-neutral-800 hover:text-app-text"
								}`}
							>
								{String(Math.round(s * 100))}%
							</button>
						))}
					</div>
				</SettingRow>

				<SettingRow
					label="Window transparency"
					hint="Blur behind the window (macOS). Takes effect after reload."
				>
					<label className="flex cursor-pointer items-center gap-2 text-xs text-app-muted">
						<input
							type="checkbox"
							data-testid="transparency-toggle"
							checked={transparency}
							onChange={(e) => onChangeTransparency(e.target.checked)}
							className="h-4 w-4 accent-blue-500"
						/>
						{transparency ? "On — reload to apply changes" : "Off"}
					</label>
				</SettingRow>
			</div>
		</div>
	);
}

function SafetySection(): React.JSX.Element {
	return (
		<div>
			<SectionHeader
				title="Safety"
				hint="How much the agent may do without asking. Per-session overrides live in the composer."
			/>
			<div className="flex flex-col gap-5">
				<SettingRow
					label="Default permission mode"
					hint="Applied to new sessions. Can be changed per session from the composer."
				>
					<DefaultModePicker />
				</SettingRow>
			</div>
		</div>
	);
}

function SoundSection(): React.JSX.Element {
	return (
		<div>
			<SectionHeader title="Sound" hint="Audio feedback for agent activity." />
			<SettingRow label="Sound effects" hint="Task completion, errors, notifications">
				<SoundToggle />
			</SettingRow>
		</div>
	);
}

function SettingRow({
	label,
	hint,
	children,
}: {
	label: string;
	hint?: string;
	children: React.ReactNode;
}): React.JSX.Element {
	return (
		<div className="flex items-center justify-between gap-4">
			<div>
				<div className="text-sm text-neutral-200">{label}</div>
				{hint !== undefined && <div className="text-[10px] text-neutral-500">{hint}</div>}
			</div>
			{children}
		</div>
	);
}

function Toggle({
	checked,
	onChange,
}: {
	checked: boolean;
	onChange(value: boolean): void;
}): React.JSX.Element {
	return (
		<button
			type="button"
			onClick={() => onChange(!checked)}
			className={`h-5 w-9 rounded-full transition ${checked ? "bg-blue-600" : "bg-neutral-700"}`}
		>
			<span
				className={`block h-4 w-4 rounded-full bg-white transition ${
					checked ? "translate-x-4.5 ml-4" : "ml-0.5"
				}`}
			/>
		</button>
	);
}

function DefaultModePicker(): React.JSX.Element {
	const [mode, setMode] = useState<PermissionMode>(DEFAULT_PERMISSION_MODE);

	useEffect(() => {
		void window.piDesktop
			.invoke({ type: "app.settings.get", key: "permissionMode" })
			.then((r) => {
				if (r.ok && isPermissionMode(r.data)) setMode(r.data);
			});
	}, []);

	return (
		<div className="flex flex-col gap-1.5" data-testid="settings-default-mode">
			{permissionModes.map((m) => (
				<label
					key={m}
					className="flex cursor-pointer items-center gap-2.5 text-xs text-neutral-300"
				>
					<input
						type="radio"
						name="defaultPermissionMode"
						checked={mode === m}
						onChange={() => {
							setMode(m);
							void window.piDesktop.invoke({
								type: "app.settings.set",
								key: "permissionMode",
								value: JSON.stringify(m),
							});
							void window.piDesktop.invoke({
								type: "permission.set_default",
								mode: m,
							});
						}}
						className="h-3.5 w-3.5 accent-blue-600"
					/>
					<span>
						{PERMISSION_MODE_LABEL[m]}
						<span className="ml-1.5 text-[10px] text-neutral-500">
							{MODE_DESCRIPTION[m]}
						</span>
					</span>
				</label>
			))}
		</div>
	);
}

function SoundToggle(): React.JSX.Element {
	const [enabled, setEnabled] = useState(true);

	useEffect(() => {
		void window.piDesktop
			.invoke({ type: "app.settings.get", key: "soundEnabled" })
			.then((r) => {
				if (r.ok && r.data !== null) setEnabled(r.data === true);
			});
	}, []);

	return (
		<button
			type="button"
			onClick={() => {
				const next = !enabled;
				setEnabled(next);
				void window.piDesktop.invoke({
					type: "app.settings.set",
					key: "soundEnabled",
					value: JSON.stringify(next),
				});
			}}
			className={`h-5 w-9 rounded-full transition ${enabled ? "bg-blue-600" : "bg-neutral-700"}`}
		>
			<span
				className={`block h-4 w-4 rounded-full bg-white transition ${
					enabled ? "ml-[18px]" : "ml-0.5"
				}`}
			/>
		</button>
	);
}