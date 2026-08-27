/**
 * Apply a theme preset to the document (phase 7, ch31).
 *
 * Writes each preset token to the root element as a `--pi-<kebab-name>`
 * custom property, and toggles `data-theme-dark` — index.css consumes it to
 * set `color-scheme`, so native widgets (checkboxes, radios, scrollbars)
 * follow the preset's dark/light branch.
 *
 * NOTE: preset keys are camelCase (`surface2`, `accentSoft`) while the
 * stylesheet reads kebab-case (`--pi-surface-2`, `--pi-accent-soft`).
 * The conversion below is what keeps those two halves in sync — writing
 * the raw key produced dead properties (`--pi-surface2`) and left the
 * dark `:root` defaults in force, so light themes rendered with
 * near-black chips, borders, and inline code.
 */
import { getPreset } from "../../../shared/theme";

/** `surface2` -> `surface-2`, `accentSoft` -> `accent-soft`. */
export function cssVarName(key: string): string {
	return `--pi-${key
		.replace(/([a-z])([A-Z])/g, "$1-$2")
		.replace(/([a-zA-Z])(\d)/g, "$1-$2")
		.toLowerCase()}`;
}

export function applyTheme(presetId: string): void {
	const preset = getPreset(presetId);
	const root = document.documentElement;
	for (const [key, value] of Object.entries(preset.vars)) {
		root.style.setProperty(cssVarName(key), value as string);
	}
	root.dataset.themeDark = preset.dark ? "true" : "false";
}
