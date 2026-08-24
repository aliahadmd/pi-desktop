/**
 * Appearance presets (phase 7, ch31).
 *
 * A preset maps semantic token names to colors. `applyTheme` writes each
 * entry to the document root as `--pi-<key>`. The shiki field names which
 * loaded shiki theme highlights code blocks for this preset.
 */
export interface ThemePreset {
	id: string;
	label: string;
	/** Dark presets keep the OS traffic lights and window chrome dark. */
	dark: boolean;
	vars: ThemeVars;
	shiki: string;
}

export interface ThemeVars {
	bg: string;
	surface: string;
	surface2: string;
	text: string;
	muted: string;
	faint: string;
	border: string;
	accent: string;
	success: string;
	danger: string;
	warning: string;
	userBubble: string;
}

/** Keys every preset must define (validated by unit test). */
export const REQUIRED_THEME_VARS: Array<keyof ThemeVars> = [
	"bg",
	"surface",
	"surface2",
	"text",
	"muted",
	"faint",
	"border",
	"accent",
	"success",
	"danger",
	"warning",
	"userBubble",
];

export const THEME_PRESETS: ThemePreset[] = [
	{
		id: "pi-dark",
		label: "Pi Dark",
		dark: true,
		vars: {
			bg: "#141416",
			surface: "#1a1a1e",
			surface2: "#232327",
			text: "#e7e7ea",
			muted: "#8b8b93",
			faint: "#5c5c64",
			border: "#2e2e33",
			accent: "#3b82f6",
			success: "#22c55e",
			danger: "#ef4444",
			warning: "#f59e0b",
			userBubble: "rgba(30, 58, 138, 0.7)",
		},
		shiki: "github-dark",
	},
	{
		id: "pi-light",
		label: "Pi Light",
		dark: false,
		vars: {
			bg: "#fafafa",
			surface: "#ffffff",
			surface2: "#f0f0f2",
			text: "#1a1a1e",
			muted: "#6b6b73",
			faint: "#9a9aa2",
			border: "#e4e4e8",
			accent: "#2563eb",
			success: "#16a34a",
			danger: "#dc2626",
			warning: "#d97706",
			userBubble: "rgba(219, 234, 254, 0.9)",
		},
		shiki: "github-light",
	},
	{
		id: "catppuccin-mocha",
		label: "Catppuccin Mocha",
		dark: true,
		vars: {
			bg: "#1e1e2e",
			surface: "#181825",
			surface2: "#313244",
			text: "#cdd6f4",
			muted: "#a6adc8",
			faint: "#7f849c",
			border: "#45475a",
			accent: "#89b4fa",
			success: "#a6e3a1",
			danger: "#f38ba8",
			warning: "#fab387",
			userBubble: "rgba(49, 50, 68, 0.85)",
		},
		shiki: "catppuccin-mocha",
	},
	{
		id: "solarized-light",
		label: "Solarized Light",
		dark: false,
		vars: {
			bg: "#fdf6e3",
			surface: "#eee8d5",
			surface2: "#e4ddc8",
			text: "#073642",
			muted: "#657b83",
			faint: "#93a1a1",
			border: "#ddd6c1",
			accent: "#268bd2",
			success: "#859900",
			danger: "#dc322f",
			warning: "#b58900",
			userBubble: "rgba(238, 232, 213, 0.95)",
		},
		shiki: "solarized-light",
	},
	{
		id: "github-dark",
		label: "GitHub Dark",
		dark: true,
		vars: {
			bg: "#0d1117",
			surface: "#161b22",
			surface2: "#21262d",
			text: "#e6edf3",
			muted: "#8b949e",
			faint: "#6e7681",
			border: "#30363d",
			accent: "#2f81f7",
			success: "#3fb950",
			danger: "#f85149",
			warning: "#d29922",
			userBubble: "rgba(33, 38, 45, 0.85)",
		},
		shiki: "github-dark-default",
	},
];

export const DEFAULT_THEME_ID = "pi-dark";

export function isThemePresetId(value: unknown): value is string {
	return (
		typeof value === "string" && THEME_PRESETS.some((p) => p.id === value)
	);
}

export function getPreset(id: string): ThemePreset {
	const found = THEME_PRESETS.find((p) => p.id === id);
	return found ?? THEME_PRESETS[0]!;
}

/** Map a preset id to the shiki theme name used for code blocks. */
export function shikiThemeFor(presetId: string): string {
	return getPreset(presetId).shiki;
}
