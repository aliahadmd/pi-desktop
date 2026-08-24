/**
 * Apply a theme preset to the document (phase 7, ch31).
 * Writes each token to the root element as --pi-<key>; also toggles
 * data-theme-dark for any CSS that needs a dark/light branch.
 */
import { getPreset } from "../../../shared/theme";

export function applyTheme(presetId: string): void {
	const preset = getPreset(presetId);
	const root = document.documentElement;
	for (const [key, value] of Object.entries(preset.vars)) {
		root.style.setProperty(`--pi-${key}`, value as string);
	}
	root.dataset.themeDark = preset.dark ? "true" : "false";
}
