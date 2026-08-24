/**
 * Markdown rendering with GFM; code blocks highlighted via the shared shiki
 * module (theme-aware). Raw HTML from the model is never rendered (skipHtml
 * default in react-markdown with rehype-raw absent), links restricted at the
 * anchor renderer.
 *
 * Element colors are token-driven: headings, lists, tables, quotes, and
 * inline code all read --pi-* variables so every preset styles them.
 */
import { memo, useEffect, useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useThemeId } from "../../lib/theme-context";
import {
	ensureLanguage,
	highlight,
	langFor,
} from "../../lib/highlight";
import { shikiThemeFor } from "../../../../shared/theme";

function CodeBlock({ code, lang }: { code: string; lang: string }): ReactNode {
	const themeId = useThemeId();
	const shikiTheme = shikiThemeFor(themeId);
	const [html, setHtml] = useState<string | null>(null);
	useEffect(() => {
		let cancelled = false;
		const id = langFor(lang);
		void (async () => {
			if (!(await ensureLanguage(id))) return;
			const out = await highlight(code.replace(/\n$/, ""), id, shikiTheme);
			if (!cancelled) setHtml(out);
		})().catch(() => {});
		return () => {
			cancelled = true;
		};
	}, [code, lang, shikiTheme]);
	return (
		<div className="group/code relative my-2 overflow-hidden rounded-lg border border-app-border bg-app-surface">
			{lang !== "" && (
				<span className="absolute right-2 top-1.5 rounded bg-app-surface2 px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wide text-app-faint">
					{lang}
				</span>
			)}
			{html === null ? (
				<pre className="overflow-x-auto p-3 text-xs text-app-muted">
					<code>{code}</code>
				</pre>
			) : (
				<div
					className="overflow-x-auto p-3 [&_pre]:bg-transparent [&_code]:text-xs"
					dangerouslySetInnerHTML={{ __html: html }}
				/>
			)}
		</div>
	);
}

export const Markdown = memo(function Markdown({ text }: { text: string }): ReactNode {
	return (
		<div
			className="text-sm leading-relaxed text-app-text
				[&_a]:text-accent-strong [&_a]:underline [&_a:hover]:text-accent
				[&_blockquote]:border-l-2 [&_blockquote]:border-app-border [&_blockquote]:pl-3 [&_blockquote]:text-app-muted [&_blockquote]:italic
				[&_code]:font-mono
				[&_h1]:mb-2 [&_h1]:mt-3 [&_h1]:text-base [&_h1]:font-semibold [&_h1]:text-app-text
				[&_h2]:mb-2 [&_h2]:mt-3 [&_h2]:text-sm [&_h2]:font-semibold [&_h2]:text-app-text
				[&_h3]:mb-1.5 [&_h3]:mt-2 [&_h3]:text-sm [&_h3]:font-medium [&_h3]:text-app-text
				[&_hr]:border-app-border
				[&_li]:ml-4 [&_li]:list-disc [&_ol_li]:list-decimal [&_li::marker]:text-accent-strong
				[&_p]:mb-2
				[&_strong]:font-semibold [&_strong]:text-app-text
				[&_table]:w-full [&_table]:text-xs [&_th]:border-b [&_th]:border-app-border [&_th]:px-2 [&_th]:py-1 [&_th]:text-left [&_th]:font-semibold [&_td]:border-b [&_td]:border-neutral-800/50 [&_td]:px-2 [&_td]:py-1"
		>
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
							<span className="text-app-muted">{children}</span>
						);
					},
					code: ({ className, children }) => {
						const raw = String(children);
						if (raw.includes("\n")) {
							const lang = /language-(\w+)/.exec(className ?? "")?.[1] ?? "";
							return <CodeBlock code={raw} lang={lang} />;
						}
						return (
							<code className="rounded bg-app-surface2 px-1 py-0.5 font-mono text-xs text-accent-strong">
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
