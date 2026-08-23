/**
 * ⌘K command palette (audit C-2): one surface that makes the session-action
 * IPC channels (rename / clone / switch / abort bash) reachable, plus open
 * sessions, dock tabs, sheets, and pi commands (skills/prompts/extensions).
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useSessions } from "../../stores/pi-sessions";
import type { PiModelInfo } from "../../../../shared/pi";

type DockTab = "files" | "review" | "commands" | "tree" | "terminal";
type SheetKind = "models" | "settings" | "trust" | "browse" | "packages";

interface PiCommandInfo {
	name: string;
	description?: string;
	source: string;
}

/** Subset of PiModelInfo the palette needs. */
interface SessionModelRow {
	provider: string;
	id: string;
	name: string;
}

interface PaletteItem {
	id: string;
	label: string;
	section: string;
	hint?: string;
	run(): void;
}

interface IndexedSessionRow {
	id: string | null;
	filePath: string;
	name: string | null;
	cwd: string | null;
}

export function CommandPalette({
	sessionId,
	onClose,
	onOpenSheet,
	onSetDockTab,
	onInsertComposer,
	onOpenCompact,
	onNewSession,
}: {
	sessionId: string;
	onClose(): void;
	onOpenSheet(kind: SheetKind): void;
	onSetDockTab(tab: DockTab): void;
	onInsertComposer(text: string): void;
	onOpenCompact(): void;
	onNewSession(backend: "sdk" | "rpc"): void;
}): React.JSX.Element {
	const sessions = useSessions((s) => s.sessions);
	const setActive = useSessions((s) => s.setActive);
	const [query, setQuery] = useState("");
	const [commands, setCommands] = useState<PiCommandInfo[]>([]);
	/** Non-null: the input is collecting a new session name. */
	const [renameValue, setRenameValue] = useState<string | null>(null);
	/** True: the list shows indexed sessions to switch this tab's backend onto. */
	const [switching, setSwitching] = useState(false);
	const [switchTargets, setSwitchTargets] = useState<IndexedSessionRow[]>([]);
	/** True: the list shows the session's available models to apply. */
	const [pickingModel, setPickingModel] = useState(false);
	const [modelChoices, setModelChoices] = useState<SessionModelRow[]>([]);
	const [selected, setSelected] = useState(0);
	const inputRef = useRef<HTMLInputElement>(null);

	useEffect(() => {
		inputRef.current?.focus();
	}, []);

	useEffect(() => {
		let cancelled = false;
		void window.piDesktop
			.invoke({ type: "session.commands", sessionId })
			.then((r) => {
				if (!cancelled && r.ok) setCommands(r.data.commands as PiCommandInfo[]);
			})
			.catch(() => {});
		return () => {
			cancelled = true;
		};
	}, [sessionId]);

	function loadSwitchTargets(): void {
		setSwitching(true);
		void window.piDesktop
			.invoke({ type: "db.sessions.list", limit: 30 })
			.then((r) => {
				if (r.ok) setSwitchTargets(r.data.sessions as IndexedSessionRow[]);
			})
			.catch(() => setSwitching(false));
	}

	function loadModelChoices(): void {
		setPickingModel(true);
		void window.piDesktop
			.invoke({ type: "session.models", sessionId })
			.then((r) => {
				if (r.ok) {
					setModelChoices(
						(r.data.models as PiModelInfo[]).map((m) => ({
							provider: m.provider,
							id: m.id,
							name: m.name,
						}))
					);
				} else {
					useSessions.getState().pushErrorNotice(sessionId, r.error.message);
					setPickingModel(false);
				}
			})
			.catch(() => setPickingModel(false));
	}

	async function applyModel(provider: string, modelId: string): Promise<void> {
		const result = await window.piDesktop.invoke({
			type: "session.set_model",
			sessionId,
			provider,
			modelId,
		});
		if (!result.ok) {
			useSessions.getState().pushErrorNotice(sessionId, result.error.message);
		} else {
			const state = await window.piDesktop.invoke({ type: "session.state", sessionId });
			if (state.ok) useSessions.getState().refreshState(sessionId, state.data);
		}
		onClose();
	}

	async function rename(name: string): Promise<void> {
		const trimmed = name.trim();
		if (trimmed.length === 0) return;
		const result = await window.piDesktop.invoke({
			type: "session.rename",
			sessionId,
			name: trimmed,
		});
		if (result.ok) {
			useSessions.getState().pushNotice(sessionId, `Session renamed to "${trimmed}".`, "info");
			onClose();
		} else {
			useSessions.getState().pushErrorNotice(sessionId, result.error.message);
		}
	}

	function runBashAbort(): void {
		void window.piDesktop
			.invoke({ type: "session.abort_bash", sessionId })
			.then((r) => {
				if (!r.ok) useSessions.getState().pushErrorNotice(sessionId, r.error.message);
			});
		onClose();
	}

	async function clone(): Promise<void> {
		const result = await window.piDesktop.invoke({ type: "session.clone", sessionId });
		if (!result.ok) useSessions.getState().pushErrorNotice(sessionId, result.error.message);
		// On success the store re-hydrates via the session_replaced event.
		onClose();
	}

	async function switchTo(target: IndexedSessionRow): Promise<void> {
		const result = await window.piDesktop.invoke({
			type: "session.switch",
			sessionId,
			sessionPath: target.filePath,
		});
		if (!result.ok) useSessions.getState().pushErrorNotice(sessionId, result.error.message);
		onClose();
	}

	async function exportSession(kind: "html" | "jsonl"): Promise<void> {
		const result = await window.piDesktop.invoke(
			kind === "html"
				? { type: "session.export_html", sessionId }
				: { type: "session.export_jsonl", sessionId }
		);
		if (result.ok) {
			const data = result.data as { path?: string };
			useSessions
				.getState()
				.pushNotice(sessionId, `Exported to ${data.path ?? "file"}.`, "info");
		} else {
			useSessions.getState().pushErrorNotice(sessionId, result.error.message);
		}
		onClose();
	}

	const items = useMemo<PaletteItem[]>(() => {
		if (renameValue !== null || switching || pickingModel) return []; // sub-modes drive the list themselves
		const list: PaletteItem[] = [];

		for (const s of Object.values(sessions)) {
			if (s.id === sessionId) continue;
			list.push({
				id: `open-${s.id}`,
				label: s.cwd.split("/").pop() ?? s.cwd,
				section: "Open sessions",
				...(s.phase !== "idle" ? { hint: s.phase } : {}),
				run: () => {
					setActive(s.id);
					onClose();
				},
			});
		}

		list.push(
			{
				id: "act-rename",
				label: "Rename session…",
				section: "Session actions",
				run: () => {
					const current = sessions[sessionId]?.cwd.split("/").pop() ?? "";
					setQuery("");
					setRenameValue(current);
				},
			},
			{
				id: "act-clone",
				label: "Clone session",
				section: "Session actions",
				hint: "fork at the current tip into a new file",
				run: () => void clone(),
			},
			{
				id: "act-switch",
				label: "Switch session file…",
				section: "Session actions",
				hint: "load another session into this tab",
				run: loadSwitchTargets,
			},
			{
				id: "act-set-model",
				label: "Set model…",
				section: "Session actions",
				hint: "apply a model to this session",
				run: loadModelChoices,
			},
			{
				id: "act-abort-bash",
				label: "Abort running shell command",
				section: "Session actions",
				hint: "! / !! bash started from the composer",
				run: runBashAbort,
			},
			{
				id: "act-compact",
				label: "Compact context…",
				section: "Session actions",
				run: () => {
					onOpenCompact();
					onClose();
				},
			},
			{
				id: "act-export-html",
				label: "Export as HTML",
				section: "Session actions",
				run: () => void exportSession("html"),
			},
			{
				id: "act-export-jsonl",
				label: "Export as JSONL",
				section: "Session actions",
				run: () => void exportSession("jsonl"),
			},
		);

		const dockTabs: Array<{ tab: DockTab; label: string }> = [
			{ tab: "files", label: "Files" },
			{ tab: "review", label: "Review queue" },
			{ tab: "commands", label: "Commands" },
			{ tab: "tree", label: "Session tree" },
			{ tab: "terminal", label: "Terminal" },
		];
		for (const { tab, label } of dockTabs) {
			list.push({
				id: `view-dock-${tab}`,
				label,
				section: "View",
				run: () => {
					onSetDockTab(tab);
					onClose();
				},
			});
		}
		const sheets: Array<{ kind: SheetKind; label: string }> = [
			{ kind: "models", label: "Models & providers" },
			{ kind: "settings", label: "Settings" },
			{ kind: "trust", label: "Project trust & keybindings" },
			{ kind: "browse", label: "All sessions" },
			{ kind: "packages", label: "Package marketplace" },
		];
		for (const { kind, label } of sheets) {
			list.push({
				id: `view-sheet-${kind}`,
				label,
				section: "View",
				run: () => {
					onOpenSheet(kind);
					onClose();
				},
			});
		}

		list.push(
			{
				id: "new-sdk",
				label: "New SDK session…",
				section: "New",
				run: () => {
					onNewSession("sdk");
					onClose();
				},
			},
			{
				id: "new-rpc",
				label: "New RPC session…",
				section: "New",
				run: () => {
					onNewSession("rpc");
					onClose();
				},
			},
		);

		for (const c of commands) {
			list.push({
				id: `cmd-${c.name}-${c.source}`,
				label: `/${c.name}`,
				section: "Commands",
				hint: c.description ?? c.source,
				run: () => {
					onInsertComposer(`/${c.name} `);
					onClose();
				},
			});
		}
		return list;
	}, [sessions, sessionId, commands, renameValue, switching, pickingModel]);

	const filtered = useMemo(() => {
		const q = query.trim().toLowerCase();
		if (q.length === 0) return items;
		return items.filter((item) =>
			`${item.section} ${item.label} ${item.hint ?? ""}`.toLowerCase().includes(q)
		);
	}, [items, query]);

	// In sub-modes the list is built directly instead of from `items`.
	const subItems = useMemo<PaletteItem[]>(() => {
		if (renameValue !== null) return [];
		if (switching) {
			return switchTargets.map((t) => ({
				id: `sw-${t.filePath}`,
				label: t.name ?? t.filePath.split("/").pop() ?? t.filePath,
				section: "Switch to session",
				...(t.cwd !== null ? { hint: t.cwd } : {}),
				run: () => void switchTo(t),
			}));
		}
		if (pickingModel) {
			return modelChoices.map((m) => ({
				id: `model-${m.provider}-${m.id}`,
				label: `${m.provider}/${m.id}`,
				section: "Apply model",
				hint: m.name,
				run: () => void applyModel(m.provider, m.id),
			}));
		}
		return [];
	}, [switching, switchTargets, pickingModel, modelChoices]);

	const visible =
		renameValue !== null || switching || pickingModel ? subItems : filtered;
	const clampedSelected = Math.min(selected, Math.max(0, visible.length - 1));

	function onKeyDown(e: React.KeyboardEvent): void {
		if (e.key === "Escape") {
			e.preventDefault();
			if (renameValue !== null || switching || pickingModel) {
				setRenameValue(null);
				setSwitching(false);
				setSwitchTargets([]);
				setPickingModel(false);
				setModelChoices([]);
			} else {
				onClose();
			}
			return;
		}
		if (e.key === "ArrowDown") {
			e.preventDefault();
			setSelected(Math.min(clampedSelected + 1, visible.length - 1));
			return;
		}
		if (e.key === "ArrowUp") {
			e.preventDefault();
			setSelected(Math.max(clampedSelected - 1, 0));
			return;
		}
		if (e.key === "Enter") {
			e.preventDefault();
			if (renameValue !== null) {
				void rename(renameValue);
				return;
			}
			const item = visible[clampedSelected];
			if (item !== undefined) item.run();
		}
	}

	let lastSection = "";

	return (
		<div
			className="absolute inset-0 z-50 flex items-start justify-center bg-black/60 pt-[12vh]"
			onClick={onClose}
			data-testid="command-palette"
		>
			<div
				className="w-[560px] overflow-hidden rounded-xl border border-neutral-700 bg-neutral-900 shadow-2xl"
				onClick={(e) => e.stopPropagation()}
			>
				<input
					ref={inputRef}
					value={renameValue ?? query}
					onChange={(e) => {
						setSelected(0);
						if (renameValue !== null) setRenameValue(e.target.value);
						else setQuery(e.target.value);
					}}
					onKeyDown={onKeyDown}
					placeholder={
						renameValue !== null
							? "New session name — Enter to apply"
							: switching
								? "Switch this tab to a session…"
								: pickingModel
									? "Apply a model to this session…"
									: "Type a command or search…"
					}
					className="w-full border-b border-neutral-800 bg-transparent px-4 py-3 text-sm outline-none placeholder:text-neutral-600"
				/>
				<div className="max-h-[50vh] overflow-y-auto py-1">
					{visible.length === 0 ? (
						<p className="px-4 py-3 text-xs text-neutral-600">
							{renameValue !== null
								? "Type a name and press Enter."
								: "No matching commands."}
						</p>
					) : (
						visible.map((item, i) => {
							const header =
								item.section !== lastSection ? (
									<div
										key={`sec-${item.section}`}
										className="px-4 pb-1 pt-2 text-[10px] tracking-wide text-neutral-500 uppercase"
									>
										{item.section}
									</div>
								) : null;
							lastSection = item.section;
							return (
								<div key={item.id}>
									{header}
									<button
										type="button"
										data-testid="palette-item"
										onMouseEnter={() => setSelected(i)}
										onClick={() => item.run()}
										className={`flex w-full items-center gap-2 px-4 py-1.5 text-left text-xs ${
											i === clampedSelected
												? "bg-blue-950/70 text-blue-100"
												: "text-neutral-300 hover:bg-neutral-800/60"
										}`}
									>
										<span className="truncate">{item.label}</span>
										{item.hint !== undefined && (
											<span className="ml-auto truncate pl-3 text-[10px] text-neutral-500">
												{item.hint}
											</span>
										)}
									</button>
								</div>
							);
						})
					)}
				</div>
			</div>
		</div>
	);
}
