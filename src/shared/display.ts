/** UI scale options (phase 7, ch32). Pure helpers live here so unit tests
 *  can import them without the electron runtime. */
export const SCALES = [0.9, 1.0, 1.1, 1.3, 1.5] as const;
export type UiScale = (typeof SCALES)[number];

export function clampScale(value: unknown): UiScale {
	const n = typeof value === "number" ? value : Number(value);
	return (SCALES as readonly number[]).includes(n) ? (n as UiScale) : 1;
}
