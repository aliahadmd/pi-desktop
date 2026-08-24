/**
 * Shared shiki highlighting (phase 7 follow-up): one lazy highlighter for
 * chat code blocks AND the dock's file preview, theme-aware via the active
 * preset. Languages load on demand — the base set covers common cases and
 * `loadLanguage` pulls any other bundled grammar when a file needs it.
 */
import type { Highlighter, BundledLanguage } from "shiki";

let shikiHighlighter: Promise<Highlighter> | null = null;

/** Themes across all presets (shiki dedupes shared grammars internally). */
export const SHIKI_THEMES = [
	"github-dark",
	"github-light",
	"catppuccin-mocha",
	"solarized-light",
] as const;

/** Every preset's shiki field must name a loaded theme (unit-tested). */
export function isSupportedShikiTheme(theme: string): boolean {
	return (SHIKI_THEMES as readonly string[]).includes(theme);
}

/** Grammars preloaded at highlighter creation. */
const BASE_LANGS = [
	"typescript",
	"javascript",
	"json",
	"bash",
	"python",
	"markdown",
] as const;

async function getHighlighter(): Promise<Highlighter> {
	if (shikiHighlighter === null) {
		const promise = import("shiki").then((shiki) =>
			shiki.createHighlighter({
				themes: [...SHIKI_THEMES],
				langs: [...BASE_LANGS],
				// The renderer's CSP forbids 'unsafe-eval', so shiki's default
				// Oniguruma engine (WebAssembly) cannot instantiate — it threw
				// CompileError and every code surface silently fell back to
				// plain text. The pure-JavaScript engine needs no eval/wasm.
				engine: shiki.createJavaScriptRegexEngine({ forgiving: true }),
			}),
		);
		shikiHighlighter = promise;
		promise.catch((err: unknown) => {
			console.error("[highlight] highlighter init failed", err);
			if (shikiHighlighter === promise) shikiHighlighter = null;
		});
	}
	return shikiHighlighter;
}

/**
 * The shared highlighter instance, for surfaces that tokenize themselves
 * instead of asking for HTML — CodeEditor feeds it to codemirror-shiki so the
 * editor colors code with the same grammars, themes, and engine as chat code
 * blocks and the file preview. One highlighter, one set of colors everywhere.
 */
export async function getSharedHighlighter(): Promise<Highlighter> {
	return getHighlighter();
}

/** File-extension → shiki language id. */
const EXT_TO_LANG: Record<string, BundledLanguage> = {
	ts: "typescript",
	tsx: "tsx",
	mts: "typescript",
	js: "javascript",
	jsx: "jsx",
	mjs: "javascript",
	cjs: "javascript",
	json: "json",
	jsonc: "json",
	sh: "bash",
	bash: "bash",
	zsh: "shell",
	py: "python",
	py3: "python",
	rb: "ruby",
	rs: "rust",
	go: "go",
	java: "java",
	kt: "kotlin",
	c: "c",
	h: "c",
	cpp: "cpp",
	cc: "cpp",
	hpp: "cpp",
	cs: "csharp",
	php: "php",
	swift: "swift",
	sql: "sql",
	html: "html",
	htm: "html",
	vue: "vue",
	svelte: "svelte",
	css: "css",
	scss: "scss",
	less: "less",
	yml: "yaml",
	yaml: "yaml",
	toml: "toml",
	xml: "xml",
	md: "markdown",
	mdx: "mdx",
	dockerfile: "dockerfile",
	ini: "ini",
	lua: "lua",
	pl: "perl",
	r: "r",
};

/** Language ids whose grammar name differs from the extension map value. */
const NAME_TO_LANG: Record<string, string> = {
	makefile: "makefile",
	dockerfile: "dockerfile",
	shell: "shell",
};

/**
 * Synchronous membership check against shiki's bundled language ids.
 * The dynamic import is cached after the first call; unknown langs before
 * the cache resolves fall through to the extension map (acceptable — the
 * async ensureLanguage re-validates against the real bundle).
 */
let bundledIdsCache: Set<string> | null = null;
export async function initBundledLangs(): Promise<void> {
	if (bundledIdsCache !== null) return;
	const shiki = await import("shiki");
	bundledIdsCache = new Set(Object.keys(shiki.bundledLanguages));
}
function isBundledLanguage(name: string): boolean {
	// Common language names that shiki bundles; keeps langFor sync-safe.
	const COMMON = new Set([
		"python", "ruby", "sql", "rust", "go", "java", "kotlin", "swift",
		"php", "perl", "lua", "r", "c", "cpp", "csharp", "html", "xml",
		"css", "scss", "less", "yaml", "toml", "ini", "vue", "svelte",
	]);
	return COMMON.has(name) || (bundledIdsCache?.has(name) ?? false);
}

/** Map a filename or explicit language tag to a bundled shiki language id. */
export function langFor(filenameOrLang: string): BundledLanguage | "text" {
	const name = filenameOrLang.toLowerCase().trim();
	if (name === "" || name === "text" || name === "plain") return "text";
	if (name in NAME_TO_LANG) return NAME_TO_LANG[name] as BundledLanguage;
	const byName = EXT_TO_LANG[name];
	if (byName !== undefined) return byName;
	// treat as an extension
	const ext = name.includes(".") ? (name.split(".").pop() ?? "") : name;
	const byExt = ext !== undefined ? EXT_TO_LANG[ext] : undefined;
	if (byExt !== undefined) return byExt;
	// Fall back to shiki's own alias table so explicit language ids like
	// "python", "ruby", "sql" resolve even without an extension mapping.
	return isBundledLanguage(name) ? (name as BundledLanguage) : "text";
}

/**
 * Ensure the given language's grammar is loaded into the shared highlighter.
 * Returns false when shiki has no such bundled grammar (caller falls back to
 * plain text rendering).
 */
export async function ensureLanguage(
	lang: BundledLanguage | "text",
): Promise<boolean> {
	if (lang === "text") return true;
	const shiki = await import("shiki");
	const h = await getHighlighter();
	const loaded = h.getLoadedLanguages();
	if (loaded.includes(lang)) return true;
	if (!(lang in shiki.bundledLanguages)) {
		console.error("[highlight] no bundled grammar for", lang);
		return false;
	}
	try {
		await h.loadLanguage(lang);
		return true;
	} catch (err) {
		console.error("[highlight] loadLanguage failed", lang, err);
		return false;
	}
}

/** Highlight `code` with the named preset's shiki theme. */
export async function highlight(
	code: string,
	lang: BundledLanguage | "text",
	shikiTheme: string,
): Promise<string> {
	const h = await getHighlighter();
	// Single `theme` (not the dual light/dark `themes` map): the app already
	// swaps presets explicitly, and the dual form emits --shiki-* custom
	// properties that need extra CSS to become real colors — without it every
	// token inherited one flat color and code looked unhighlighted.
	return h.codeToHtml(code, { lang, theme: shikiTheme });
}
