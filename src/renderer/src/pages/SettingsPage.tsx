/**
 * Settings page: Pi settings editor (typed form for common keys) + app info.
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

export function SettingsPage({
	themeId,
	onChangeTheme,
}: {
	themeId: string;
	onChangeTheme(next: string): void;
}): React.JSX.Element {
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
		setSaved(false);
		try {
			const result = await window.piDesktop.invoke({
				type: "pi.settings.set",
				key,
				value: JSON.stringify(value),
			});
			if (!result.ok) {
				setError(result.error.message);
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
		<div className="h-full overflow-y-auto p-6">
			<div className="max-w-xl">
				<h2 className="mb-1 text-base font-semibold text-neutral-100">Pi settings</h2>
				<p className="mb-5 text-xs text-neutral-500">
					Edits pi's global settings (~/.pi/agent/settings.json). Project settings stay in
					each repo's .pi/settings.json.
				</p>

				{error !== null && (
					<div className="mb-3 rounded border border-red-900 bg-red-950/50 px-3 py-2 text-xs text-red-300">
						{error}
					</div>
				)}
				{saved && (
					<div className="mb-3 rounded border border-green-900 bg-green-950/50 px-3 py-2 text-xs text-green-300">
						Saved.
					</div>
				)}

				<div className="flex flex-col gap-5">
					<SettingRow label="Default provider" hint="Used when no model is restored from a session">
						<input
							value={settings.defaultProvider ?? ""}
							onChange={(e) => setSettings((s) => ({ ...s, defaultProvider: e.target.value }))}
							onBlur={(e) => void save("defaultProvider", e.target.value)}
							placeholder="anthropic"
							className="w-48 rounded border border-neutral-700 bg-neutral-900 px-3 py-1.5 text-xs outline-none focus:border-blue-500"
						/>
					</SettingRow>

					<SettingRow label="Default model" hint="Model id, e.g. claude-sonnet-4-5">
						<input
							value={settings.defaultModel ?? ""}
							onChange={(e) => setSettings((s) => ({ ...s, defaultModel: e.target.value }))}
							onBlur={(e) => void save("defaultModel", e.target.value)}
							placeholder="model id"
							className="w-48 rounded border border-neutral-700 bg-neutral-900 px-3 py-1.5 text-xs outline-none focus:border-blue-500"
						/>
					</SettingRow>

					<SettingRow label="Default thinking level">
						<select
							value={settings.defaultThinkingLevel ?? "medium"}
							onChange={(e) => void save("defaultThinkingLevel", e.target.value)}
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
								void save("hideThinkingBlock", v);
							}}
						/>
					</SettingRow>

					<SettingRow label="Auto-compaction" hint="Summarize context automatically when nearly full">
						<Toggle
							checked={settings.compaction?.enabled !== false}
							onChange={(v) => {
								const next = { ...settings, compaction: { ...settings.compaction, enabled: v } };
								setSettings(next);
								void save("compactionEnabled", v);
							}}
						/>
					</SettingRow>

					<SettingRow label="Auto-retry" hint="Retry transient provider errors automatically">
						<Toggle
							checked={settings.retry?.enabled !== false}
							onChange={(v) => {
								const next = { ...settings, retry: { ...settings.retry, enabled: v } };
								setSettings(next);
								void save("retryEnabled", v);
							}}
						/>
					</SettingRow>
				</div>

				<div className="mt-8 border-t border-neutral-800 pt-5">
					<ScopedModelsEditor />
				</div>

				<div className="mt-8 border-t border-neutral-800 pt-5">
					<div className="mb-2 text-sm text-neutral-200">Appearance</div>
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
				</div>

				<div className="mt-8 border-t border-neutral-800 pt-5">
					<div className="mb-2 text-sm text-neutral-200">Safety</div>
					<SettingRow
						label="Default permission mode"
						hint="Applied to new sessions. Can be changed per session from the composer."
					>
						<DefaultModePicker />
					</SettingRow>
				</div>

				<div className="mt-8 border-t border-neutral-800 pt-5">
					<div className="mb-2 text-sm text-neutral-200">Sound</div>
					<SettingRow label="Sound effects" hint="Task completion, errors, notifications">
						<SoundToggle />
					</SettingRow>
				</div>

				<div className="mt-8 border-t border-neutral-800 pt-5">
					<PackagesPanel />
				</div>



				<div className="mt-8 border-t border-neutral-800 pt-4 text-[10px] text-neutral-600">
					{saving ? "Saving…" : "Changes write through pi's SettingsManager."}
				</div>
			</div>
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
