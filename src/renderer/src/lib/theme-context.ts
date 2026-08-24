/**
 * Theme context (phase 7): exposes the active preset id so deep components
 * (code blocks) can re-render when the theme changes without prop drilling.
 */
import { createContext, useContext } from "react";

export const ThemeContext = createContext<string>("pi-dark");

export function useThemeId(): string {
	return useContext(ThemeContext);
}
