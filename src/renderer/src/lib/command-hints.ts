/**
 * Argument-hint parsing for the Commands browser.
 *
 * Two sources exist and they are NOT the same format:
 *
 *  - Upstream `PromptTemplate.argumentHint` is a bare hint string as authored,
 *    e.g. `"<file> <pattern>"` or `"file pattern"`. Parsed by
 *    `parseArgumentHintFromHint`.
 *  - A prompt/skill markdown file's frontmatter carries the same information as
 *    `argument-hint: "<file>"`. Parsed by `parseArgumentHint` in Dock.tsx after
 *    fetching the file.
 *
 * Keeping this module free of React/Electron imports makes it unit-testable.
 */

/**
 * Split an upstream argument-hint string into placeholder names.
 *
 * Hints are authored for humans and are not a strict grammar. Real examples:
 *
 *   "<file>"
 *   "<question> [--advisors name,name] [--max-passes 2|3]"
 *   "file pattern"
 *
 * Bracketed groups are taken as ONE placeholder each, including any inner
 * spaces — splitting them on whitespace would render a separate input box for
 * `--advisors` and `name,name`, demanding values the command never wanted.
 * Only when a hint contains no brackets at all do we treat whitespace as the
 * separator.
 *
 * Returns `[]` when the hint carries no usable placeholders, which callers
 * treat as "no argument form".
 */
export function parseArgumentHintFromHint(hint: string): string[] {
	const trimmed = hint.trim();
	if (trimmed.length === 0) return [];

	const names: string[] = [];
	for (const match of trimmed.matchAll(/[<[]([^>\]]+)[>\]]/g)) {
		const name = match[1]?.trim();
		if (name !== undefined && name.length > 0) names.push(name);
	}
	if (names.length > 0) return names;

	// No bracketed groups: a bare hint like "file pattern".
	return trimmed.split(/\s+/).filter((token) => token.length > 0);
}
