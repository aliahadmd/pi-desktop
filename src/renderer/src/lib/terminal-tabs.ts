/**
 * Pure terminal-tab selection arithmetic, kept out of the component so it can
 * be unit-tested without JSX (audit H-6).
 */

/** New active index after closing `closed`, given the pre-close tab count. */
export function nextActiveTerminalTab(active: number, closed: number, count: number): number {
	const next = closed < active ? active - 1 : active;
	return Math.max(0, Math.min(next, count - 2));
}
