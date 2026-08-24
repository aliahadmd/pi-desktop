/**
 * Markdown rendering with GFM; code blocks highlighted via shiki (lazy-loaded).
 * Raw HTML from the model is never rendered (skipHtml default in react-markdown
 * with rehype-raw absent), links restricted at the anchor renderer.
 */
import { memo, useEffect, useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useThemeId } from "../../lib/theme-context";
import { shikiThemeFor } from "../../../../shared/theme";

let shikiHighlighter: Promise<import("shiki").Highlighter> | null = null;

/** Every theme any preset can ask for; shiki dedupes shared grammars. */
const SHIKI_THEMES = [
	"github-dark",
	"github-light",
	"catppuccin-mocha",
	"solarized-light",
] as const;

async function getHighlighter(): Promise<import("shiki").Highlighter> {
	if (shikiHighlighter === null) {
		const promise = import("shiki").then((shiki) =>
			shiki.createHighlighter({
				themes: [...SHIKI_THEMES],
				langs: ["ts", "js", "json", "bash", "python", "md"],
			})
		);
		shikiHighlighter = promise;
		promise.catch(() => {
			if (shikiHighlighter === promise) shikiHighlighter = null;
		});
	}
	return shikiHighlighter;
}

function CodeBlock({ code, lang }: { code: string; lang: string }): ReactNode {
	const themeId = useThemeId();
	const shikiTheme = shikiThemeFor(themeId);
	const [html, setHtml] = useState<string | null>(null);
	useEffect(() => {
		let cancelled = false;
		void getHighlighter()
			.then((h) =>
				h.codeToHtml(code, {
					lang: lang || "text",
					themes: { dark: shikiTheme, light: shikiTheme },
					defaultColor: false,
				}),
			)
			.then((out) => {
				if (!cancelled) setHtml(out);
			})
			.catch(() => {});
		return () => {
			cancelled = true;
		};
	}, [code, lang, shikiTheme]);
	if (html === null) {
		return (
			<pre className="overflow-x-auto rounded bg-app-surface p-3 text-xs text-app-text">
				<code>{code}</code>
			</pre>
		);
	}
	return (
		<div
			className="overflow-x-auto rounded bg-app-surface [&_pre]:bg-transparent [&_pre]:p-3 [&_code]:text-xs"
			dangerouslySetInnerHTML={{ __html: html }}
		/>
	);
}

export const Markdown = memo(function Markdown({ text }: { text: string }): ReactNode {
	return (
		<div className="text-sm leading-relaxed text-neutral-200 [&_a]:text-accent-strong [&_a]:underline [&_h1]:mb-2 [&_h1]:text-base [&_h1]:font-semibold [&_h2]:mb-2 [&_h2]:text-sm [&_h2]:font-semibold [&_li]:ml-4 [&_li]:list-disc [&_ol_li]:list-decimal [&_p]:mb-2 [&_table]:text-xs">
			<ReactMarkdown
				remarkPlugins={[remarkGfm]}
				components={{
					a: ({ href, children }) => {
						const safe = href !== undefined && /^https?:\/\//i.test(href);
						return safe ? (
							<a href={href} target="_blank" rel="noreferrer">
								{children}
							</a>
						) : (
							<span className="text-neutral-400">{children}</span>
						);
					},
					code: ({ className, children }) => {
						const raw = String(children);
						if (raw.includes("\n")) {
							const lang = /language-(\w+)/.exec(className ?? "")?.[1] ?? "";
							return <CodeBlock code={raw.replace(/\n$/, "")} lang={lang} />;
						}
						return (
							<code className="rounded bg-neutral-800 px-1 py-0.5 font-mono text-xs">
								{children}
							</code>
						);
					},
					pre: ({ children }) => <>{children}</>,
				}}
			>
				{text}
			</ReactMarkdown>
		</div>
	);
});
