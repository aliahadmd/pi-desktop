/**
 * CodeEditor — editable, syntax-highlighted source built on CodeMirror 6.
 *
 * Why CodeMirror and not Monaco: the renderer's CSP is `script-src 'self'`
 * with no 'unsafe-eval' (see lib/highlight.ts for the outage that taught us
 * this). CodeMirror 6 ships no eval, no `new Function`, and no WebAssembly,
 * and needs no worker/blob plumbing; Monaco needs workers and is ~98MB on
 * disk. CodeMirror's injected <style> tags are covered by our
 * `style-src 'unsafe-inline'`.
 *
 * Why codemirror-shiki and not @codemirror/lang-*: the app already highlights
 * every other surface with shiki, and theme presets name shiki themes
 * (shikiThemeFor). Using Lezer grammars here would mean two highlighters and
 * two color vocabularies for the same file. This drives CodeMirror decorations
 * from shiki tokens instead, so the editor matches chat code blocks exactly
 * and inherits every preset for free — no second theme system.
 *
 * The editor is uncontrolled by design: CodeMirror owns the document, and the
 * parent hears about edits through onChange/onDirty. Pushing `value` back in
 * on every keystroke would fight the editor's own state and lose the cursor.
 */
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { bracketMatching, indentUnit } from "@codemirror/language";
import { highlightSelectionMatches, search, searchKeymap } from "@codemirror/search";
import { Compartment, EditorState, type Extension } from "@codemirror/state";
import {
	EditorView,
	highlightActiveLine,
	highlightActiveLineGutter,
	keymap,
	lineNumbers,
} from "@codemirror/view";
import shikiPlugin from "codemirror-shiki";
import { useEffect, useRef } from "react";
import { ensureLanguage, getSharedHighlighter, langFor } from "../../lib/highlight";
import { useThemeId } from "../../lib/theme-context";
import { shikiThemeFor } from "../../../../shared/theme";

/**
 * Chrome colors come from theme tokens (the CSS variables applyTheme writes),
 * never hardcoded ramps — the token rule in AGENTS.md. Token *text* colors are
 * shiki's job via the plugin above, so this theme deliberately styles only the
 * frame: background, gutter, cursor, selection, active line.
 */
function editorChrome(): Extension {
	return EditorView.theme({
		"&": {
			backgroundColor: "transparent",
			color: "var(--pi-text)",
			fontSize: "11px",
			height: "100%",
		},
		".cm-content": {
			fontFamily:
				"ui-monospace, SFMono-Regular, Menlo, Monaco, 'Cascadia Code', monospace",
			padding: "0",
		},
		".cm-scroller": { overflow: "auto", lineHeight: "1.55" },
		".cm-gutters": {
			backgroundColor: "transparent",
			color: "var(--pi-faint)",
			border: "none",
			paddingRight: "6px",
		},
		".cm-activeLineGutter": {
			backgroundColor: "transparent",
			color: "var(--pi-muted)",
		},
		".cm-activeLine": { backgroundColor: "var(--pi-surface-2)" },
		".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--pi-accent)" },
		"&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection": {
			backgroundColor: "var(--pi-accent-soft)",
		},
		".cm-selectionMatch": { backgroundColor: "var(--pi-accent-soft)" },
		"&.cm-focused": { outline: "none" },
		".cm-matchingBracket, &.cm-focused .cm-matchingBracket": {
			backgroundColor: "var(--pi-accent-soft)",
			outline: "none",
		},
		".cm-panels": {
			backgroundColor: "var(--pi-surface)",
			color: "var(--pi-text)",
			border: "1px solid var(--pi-border)",
		},
		".cm-panel input, .cm-panel button": {
			backgroundColor: "var(--pi-surface-2)",
			color: "var(--pi-text)",
			border: "1px solid var(--pi-border)",
			borderRadius: "3px",
		},
	});
}

export function CodeEditor({
	value,
	/** Filename or language id — resolved through langFor, same as CodeView. */
	lang,
	readOnly = false,
	onChange,
	onSave,
	className = "",
}: {
	value: string;
	lang: string;
	readOnly?: boolean;
	onChange?: (next: string) => void;
	onSave?: () => void;
	className?: string;
}): React.JSX.Element {
	const themeId = useThemeId();
	const host = useRef<HTMLDivElement | null>(null);
	const view = useRef<EditorView | null>(null);
	const highlighting = useRef(new Compartment());
	const editable = useRef(new Compartment());
	/**
	 * Latest callbacks, read at event time. Without this the keymap and update
	 * listener would close over the first render's props and save stale content
	 * (the same trap as the transcript's per-row state).
	 */
	const handlers = useRef({ onChange, onSave });
	handlers.current = { onChange, onSave };

	// Mount once per file. `value` is intentionally not a dependency: it is the
	// initial document, and re-creating the view on every keystroke would
	// destroy the cursor, selection, and undo history.
	useEffect(() => {
		const parent = host.current;
		if (parent === null) return;

		const state = EditorState.create({
			doc: value,
			extensions: [
				lineNumbers(),
				highlightActiveLine(),
				highlightActiveLineGutter(),
				history(),
				bracketMatching(),
				search({ top: true }),
				highlightSelectionMatches(),
				indentUnit.of("\t"),
				EditorView.lineWrapping,
				keymap.of([
					{
						key: "Mod-s",
						preventDefault: true,
						run: () => {
							handlers.current.onSave?.();
							return true;
						},
					},
					...defaultKeymap,
					...historyKeymap,
					...searchKeymap,
					indentWithTab,
				]),
				editorChrome(),
				editable.current.of([
					EditorView.editable.of(!readOnly),
					EditorState.readOnly.of(readOnly),
				]),
				highlighting.current.of([]),
				EditorView.updateListener.of((update) => {
					if (update.docChanged) {
						handlers.current.onChange?.(update.state.doc.toString());
					}
				}),
			],
		});

		const instance = new EditorView({ state, parent });
		view.current = instance;
		return () => {
			instance.destroy();
			view.current = null;
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [lang]);

	// Adopt external content changes (a different file, or a reload) without
	// tearing down the view.
	useEffect(() => {
		const instance = view.current;
		if (instance === null) return;
		const current = instance.state.doc.toString();
		if (current === value) return;
		instance.dispatch({
			changes: { from: 0, to: current.length, insert: value },
		});
	}, [value]);

	useEffect(() => {
		const instance = view.current;
		if (instance === null) return;
		instance.dispatch({
			effects: editable.current.reconfigure([
				EditorView.editable.of(!readOnly),
				EditorState.readOnly.of(readOnly),
			]),
		});
	}, [readOnly]);

	// Highlighting is reconfigured (not remounted) when the language or preset
	// changes, so switching themes keeps the cursor and undo history.
	useEffect(() => {
		let cancelled = false;
		void (async () => {
			const id = langFor(lang);
			const instance = view.current;
			if (instance === null) return;
			if (id === "text" || !(await ensureLanguage(id))) {
				if (!cancelled) {
					instance.dispatch({ effects: highlighting.current.reconfigure([]) });
				}
				return;
			}
			if (cancelled || view.current === null) return;
			view.current.dispatch({
				effects: highlighting.current.reconfigure(
					shikiPlugin({
						// Deliberately the PROMISE, not an awaited highlighter.
						// Given a resolved instance, the plugin's constructor
						// calls view.dispatch() synchronously — and because that
						// constructor runs inside the reconfigure dispatch, it
						// throws "Calls to EditorView.update are not allowed
						// while an update is in progress" and the plugin dies
						// with zero decorations (text renders, no colors). The
						// promise path defers that dispatch to a .then callback,
						// safely outside the update cycle.
						highlighter: getSharedHighlighter(),
						language: id,
						theme: shikiThemeFor(themeId),
					})
				),
			});
		})().catch((err: unknown) => {
			// Same rule as CodeView: never fail silently. A dead highlighter
			// leaves plain-but-editable text, and the cause must be visible.
			console.error("[CodeEditor] highlight setup failed", { lang, themeId }, err);
		});
		return () => {
			cancelled = true;
		};
	}, [lang, themeId]);

	return <div ref={host} className={`h-full overflow-hidden ${className}`} />;
}
