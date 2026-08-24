/**
 * Shared code rendering surfaces (phase 7 follow-up).
 *
 * Every place in the app that shows code goes through here so highlighting,
 * diff coloring, and theme tokens stay consistent:
 *
 *   CodeView   — shiki-highlighted source; language inferred or explicit
 *   DiffView   — unified-diff coloring via success/danger tokens
 *   AutoOutput — picks diff vs ANSI terminal output for tool results
 *   isDiff     — unified-diff detector
 *
 * Before this module the transcript colored diffs while the review queue
 * printed the same bytes as plain text, and TrustPanel showed JSON raw.
 */
import Ansi from "ansi-to-react";
import { useEffect, useState, type ReactNode } from "react";
import { ensureLanguage, highlight, langFor } from "../../lib/highlight";
import { useThemeId } from "../../lib/theme-context";
import { shikiThemeFor } from "../../../../shared/theme";

/** Unified-diff detector (shared by transcript and review queue). */
export const isDiff = (output: string): boolean =>
	output.startsWith("diff --git") || output.includes("\n@@ ");

/**
 * Shiki-highlighted code. `lang` accepts a language id or a filename —
 * langFor() resolves both. Falls back to plain monospace while the grammar
 * loads, or permanently when the language is unknown.
 */
export function CodeView({
	code,
	lang,
	className = "",
	maxChars = 100_000,
}: {
	code: string;
	lang: string;
	className?: string;
	maxChars?: number;
}): React.JSX.Element {
	const themeId = useThemeId();
	const [html, setHtml] = useState<string | null>(null);
	const text = code.length > maxChars ? code.slice(0, maxChars) : code;

	useEffect(() => {
		let cancelled = false;
		setHtml(null);
		const id = langFor(lang);
		if (id === "text") return;
		void (async () => {
			if (!(await ensureLanguage(id))) return;
			const out = await highlight(text, id, shikiThemeFor(themeId));
			if (!cancelled) setHtml(out);
		})().catch((err: unknown) => {
			// Never swallow silently: a bad theme/grammar id degrades to plain
			// text, and without this the cause is invisible (see phase 7 notes).
			console.error("[CodeView] highlight failed", { lang, themeId }, err);
		});
		return () => {
			cancelled = true;
		};
	}, [text, lang, themeId]);

	if (html !== null) {
		return (
			<div
				className={`overflow-x-auto font-mono [&_pre]:!bg-transparent [&_code]:leading-relaxed ${className}`}
				dangerouslySetInnerHTML={{ __html: html }}
			/>
		);
	}
	return (
		<pre className={`overflow-x-auto font-mono whitespace-pre-wrap text-app-muted ${className}`}>
			{text}
		</pre>
	);
}

/** Unified diff with per-line add/remove tinting from theme tokens. */
export function DiffView({
	diff,
	className = "",
}: {
	diff: string;
	className?: string;
}): ReactNode {
	const lines = diff.split("\n");
	return (
		<div
			className={`overflow-x-auto rounded bg-app-bg font-mono text-[11px] leading-relaxed ${className}`}
		>
			{lines.map((line, i) => {
				const cls = line.startsWith("+")
					? "bg-success-soft text-app-text"
					: line.startsWith("-")
						? "bg-danger-soft text-app-text"
						: line.startsWith("@@") || line.startsWith("diff") || line.startsWith("index")
							? "text-app-faint"
							: "text-app-muted";
				return (
					<div key={i} className={`px-3 whitespace-pre ${cls}`}>
						{line}
					</div>
				);
			})}
		</div>
	);
}

/**
 * Tool/command output: colored diff when the payload is a patch, otherwise
 * ANSI-decoded terminal text (escape sequences carry their own colors).
 */
export function AutoOutput({
	output,
	limit = 20_000,
	className = "",
}: {
	output: string;
	limit?: number;
	className?: string;
}): ReactNode {
	if (isDiff(output)) return <DiffView diff={output} className={className} />;
	return (
		<pre
			className={`overflow-auto font-mono whitespace-pre-wrap text-app-muted ${className}`}
		>
			<Ansi>{output.slice(0, limit)}</Ansi>
		</pre>
	);
}
