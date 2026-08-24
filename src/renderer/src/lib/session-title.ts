/**
 * Session tab titles (phase 6).
 *
 * pi does not auto-generate session names — `sessionName` is only set by an
 * explicit /name command. Tabs therefore fall back to the first user message
 * (the task the session is about), then the project folder, so two sessions
 * in one project stay distinguishable.
 */

/** A short single-line tab title from raw prompt text. */
export function titleFromPrompt(text: string): string {
	const line =
		text
			.split("\n")
			.map((l) => l.trim())
			.find((l) => l.length > 0) ?? "";
	// Strip common prefixes so "/command args" and "!cmd" read as their content.
	const stripped = line.replace(/^[/!]+/, "").trim();
	if (stripped.length === 0) return "";
	return stripped.length > 48 ? `${stripped.slice(0, 45).trimEnd()}…` : stripped;
}
