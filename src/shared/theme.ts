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
	/** Low-emphasis accent fill (selected rows, soft chips). Readable on both light and dark bgs. */
	accentSoft: string;
	/** High-contrast accent for text/icons on any background. */
	accentStrong: string;
	/** Accent-tinted border line. */
	accentLine: string;
	success: string;
	successSoft: string;
	danger: string;
	dangerSoft: string;
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
	"accentSoft",
	"accentStrong",
	"accentLine",
	"success",
	"successSoft",
	"danger",
	"dangerSoft",
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
			accentSoft: "rgba(59, 130, 246, 0.16)",
			accentStrong: "#7cb0fb",
			accentLine: "rgba(59, 130, 246, 0.45)",
			success: "#22c55e",
			successSoft: "rgba(34, 197, 94, 0.16)",
			danger: "#ef4444",
			dangerSoft: "rgba(239, 68, 68, 0.16)",
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
			accentSoft: "rgba(37, 99, 235, 0.10)",
			accentStrong: "#1d4ed8",
			accentLine: "rgba(37, 99, 235, 0.40)",
			success: "#16a34a",
			successSoft: "rgba(22, 163, 74, 0.12)",
			danger: "#dc2626",
			dangerSoft: "rgba(220, 38, 38, 0.10)",
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
			accentSoft: "rgba(137, 180, 250, 0.16)",
			accentStrong: "#89b4fa",
			accentLine: "rgba(137, 180, 250, 0.45)",
			success: "#a6e3a1",
			successSoft: "rgba(166, 227, 161, 0.14)",
			danger: "#f38ba8",
			dangerSoft: "rgba(243, 139, 168, 0.14)",
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
			accentSoft: "rgba(38, 139, 210, 0.12)",
			accentStrong: "#1a6fa5",
			accentLine: "rgba(38, 139, 210, 0.40)",
			success: "#859900",
			successSoft: "rgba(133, 153, 0, 0.14)",
			danger: "#dc322f",
			dangerSoft: "rgba(220, 50, 47, 0.12)",
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
			accentSoft: "rgba(47, 129, 247, 0.16)",
			accentStrong: "#6cb0ff",
			accentLine: "rgba(47, 129, 247, 0.45)",
			success: "#3fb950",
			successSoft: "rgba(63, 185, 80, 0.16)",
			danger: "#f85149",
			dangerSoft: "rgba(248, 81, 73, 0.16)",
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
