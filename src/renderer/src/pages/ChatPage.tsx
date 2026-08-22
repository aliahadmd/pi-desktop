/**
 * Chat page: session tabs, transcript, workspace dock (files/review/commands/
 * tree), terminal toggle, composer, status bar, dialogs.
 */
import { useEffect, useState } from "react";
import { playSoundIfEnabled, type SoundEvent } from "../services/sound";
import { AnimatePresence, motion } from "motion/react";
import type { PiImageInput } from "../../../shared/pi";
import { useSessions } from "../stores/pi-sessions";
import { Transcript } from "../components/chat/Transcript";
import { Composer } from "../components/chat/Composer";
import { StatusBar } from "../components/chat/StatusBar";
import { DialogModal } from "../components/chat/DialogModal";
import {
	CommandsBrowser,
	FileExplorer,
	ReviewQueue,
	SessionTreePanel,
} from "../components/workspace/Dock";
import { TerminalPanel } from "../components/workspace/TerminalPanel";

type DockTab = "files" | "review" | "commands" | "tree" | "terminal" | null;

export function refreshState(sessionId: string): void {
	void window.piDesktop
		.invoke({ type: "session.state", sessionId })
		.then((result) => {
			if (result.ok) useSessions.getState().refreshState(sessionId, result.data);
		});
}

export default function ChatPage(): React.JSX.Element {
	const sessions = useSessions((s) => s.sessions);
	const activeId = useSessions((s) => s.activeId);
	const open = useSessions((s) => s.open);
	const closeTab = useSessions((s) => s.close);
	const setActive = useSessions((s) => s.setActive);
	const addUserBlock = useSessions((s) => s.addUserBlock);
	const pushErrorNotice = useSessions((s) => s.pushErrorNotice);

	const [creating, setCreating] = useState(false);
	const [createError, setCreateError] = useState<string | null>(null);
	const [dockTab, setDockTab] = useState<DockTab>(null);
	const [treeRefreshKey, setTreeRefreshKey] = useState(0);
	const [terminalTabs, setTerminalTabs] = useState<Array<{ id: string; label: string }>>([
		{ id: "term-1", label: "Terminal 1" },
	]);
	const [activeTermTab, setActiveTermTab] = useState(0);
	const [nextTermNum, setNextTermNum] = useState(2);
	const [compactOpen, setCompactOpen] = useState(false);
	const [compactInstructions, setCompactInstructions] = useState("");
	const [compacting, setCompacting] = useState(false);
	const [insertedText, setInsertedText] = useState<string | null>(null);
	const play = (event: SoundEvent): void => {
		playSoundIfEnabled(event);
	};

	const [dockWidth, setDockWidth] = useState(320);

	useEffect(() => {
		void window.piDesktop
			.invoke({ type: "app.settings.get", key: "dockWidth" })
			.then((r) => {
				if (r.ok && typeof r.data === "number") setDockWidth(r.data);
			})
			.catch(() => {});
	}, []);

	useEffect(() => {
		if (dockWidth === 320) return;
		const t = setTimeout(() => {
			void window.piDesktop.invoke({
				type: "app.settings.set",
				key: "dockWidth",
				value: JSON.stringify(dockWidth),
			});
		}, 400);
		return () => clearTimeout(t);
	}, [dockWidth]);

	// ⌘J toggles the Terminal dock tab
	useEffect(() => {
		const onKey = (e: KeyboardEvent): void => {
			if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "j") {
				e.preventDefault();
				setDockTab((prev) => (prev === "terminal" ? null : "terminal"));
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, []);

	const sessionList = Object.values(sessions);
	const active = activeId !== null ? sessions[activeId] : undefined;
	const reviewCount =
		active?.blocks.filter(
			(b) => b.kind === "tool" && ["edit", "write"].includes(b.toolName)
		).length ?? 0;

	async function newSession(backend: "sdk" | "rpc"): Promise<void> {
		setCreating(true);
		setCreateError(null);
		try {
			const picked = await window.piDesktop.invoke({ type: "app_pick_directory" });
			if (!picked.ok || picked.data.path === null) return;
			const result = await window.piDesktop.invoke({
				type: "session.create",
				cwd: picked.data.path,
				backend,
			});
			if (result.ok) {
				open(result.data);
			} else {
				setCreateError(`${backend.toUpperCase()} session failed: ${result.error.message}`);
			}
		} finally {
			setCreating(false);
		}
	}

	function send(
		text: string,
		images: PiImageInput[],
		streamingBehavior?: "steer" | "followUp"
	): void {
		if (activeId === null) return;
		if (text.length > 0) addUserBlock(activeId, text);
		play("sent");
		void window.piDesktop
			.invoke({
				type: "session.prompt",
				sessionId: activeId,
				text,
				...(images.length > 0 ? { images } : {}),
				...(streamingBehavior !== undefined ? { streamingBehavior } : {}),
			})
			.then((result) => {
				if (!result.ok) {
					pushErrorNotice(activeId, `Prompt rejected: ${result.error.message}`);
					play("error");
				} else {
					refreshState(activeId);
				}
			});
	}

	function runBash(command: string, excludeFromContext: boolean): void {
		if (activeId === null) return;
		const requestId = `bash-${Date.now()}`;
		void window.piDesktop
			.invoke({
				type: "session.bash",
				sessionId: activeId,
				command,
				requestId,
				...(excludeFromContext ? { excludeFromContext: true } : {}),
			})
			.then((r) => {
				if (!r.ok) pushErrorNotice(activeId, r.error.message);
			});
	}

	return (
		<div className="flex h-full flex-col">
			{/* Open-session chips — only when more than one is open */}
			{sessionList.length > 1 && (
				<div className="flex h-8 shrink-0 items-center gap-1 border-b border-neutral-800 px-2">
					{sessionList.map((s) => (
						<button
							key={s.id}
							type="button"
							onClick={() => setActive(s.id)}
							className={`group flex items-center gap-1.5 rounded px-2 py-1 text-[11px] transition-standard ${
								s.id === activeId
									? "bg-neutral-800 text-neutral-100"
									: "text-neutral-500 hover:bg-neutral-900 hover:text-neutral-300"
							}`}
						>
							<span
								className={`h-1.5 w-1.5 rounded-full ${
									s.dead !== undefined
										? "bg-red-500"
										: s.phase === "idle"
											? "bg-neutral-600"
											: "bg-blue-500 animate-pulse"
								}`}
							/>
							{s.cwd.split("/").pop() ?? s.cwd}
							<span
								role="button"
								tabIndex={0}
								onClick={(e) => {
									e.stopPropagation();
									closeTab(s.id);
								}}
								onKeyDown={(e) => {
									if (e.key === "Enter") closeTab(s.id);
								}}
								className="ml-1 text-neutral-600 hover:text-neutral-300"
							>
								×
							</span>
						</button>
					))}
				</div>
			)}
			{active === undefined ? (
				<div className="flex flex-1 flex-col items-center justify-center gap-3">
					<p className="text-sm text-neutral-400">No open sessions.</p>
					{createError !== null && (
						<p className="max-w-md rounded border border-red-900 bg-red-950/50 px-3 py-1.5 text-xs text-red-300">
							{createError}
						</p>
					)}
					<div className="flex gap-2">
						<button
							type="button"
							disabled={creating}
							onClick={() => void newSession("sdk")}
							className="rounded bg-blue-600 px-4 py-2 text-xs font-medium text-white hover:bg-blue-500 disabled:opacity-40"
						>
							New SDK session…
						</button>
						<button
							type="button"
							disabled={creating}
							onClick={() => void newSession("rpc")}
							className="rounded bg-neutral-700 px-4 py-2 text-xs font-medium text-white hover:bg-neutral-600 disabled:opacity-40"
						>
							New RPC session…
						</button>
					</div>
				</div>
			) : (
<>
{/* Icon rail + dock */}
					<div className="flex min-h-0 flex-1">
						<div className="flex min-w-0 flex-1 flex-col">
							<Transcript blocks={active.blocks} phase={active.phase} />
						</div>

						{/* Icon rail (ch22) */}
						{active.phase !== undefined && (
							<div className="flex w-10 shrink-0 flex-col items-center gap-0.5 border-l border-neutral-800 py-2">
								{([
									{ tab: "files" as const, label: "📁", title: "Files" },
									{ tab: "review" as const, label: "🔍", title: `Review (${reviewCount})` },
									{ tab: "commands" as const, label: "⌘", title: "Commands" },
									{ tab: "tree" as const, label: "🌳", title: "Tree" },
								]).map(({ tab, label, title }) => (
									<button
										key={tab}
										type="button"
										data-testid={`rail-${tab}`}
										onClick={() => setDockTab(dockTab === tab ? null : tab)}
										title={title}
										className={`relative flex h-8 w-8 items-center justify-center rounded text-sm transition-standard ${
											dockTab === tab
												? "bg-neutral-800 text-blue-400"
												: "text-neutral-600 hover:bg-neutral-900 hover:text-neutral-300"
										}`}
									>
										{label}
										{tab === "review" && reviewCount > 0 && (
											<span className="absolute -right-0.5 -top-0.5 rounded-full bg-red-600 px-1 text-[8px] leading-tight text-white">
												{reviewCount}
											</span>
										)}
									</button>
								))}
							</div>
		)}

						{dockTab !== null && (
							<AnimatePresence initial={false}>
							<motion.div
								initial={{ width: 0, opacity: 0 }}
								animate={{ width: `${dockWidth}px`, opacity: 1 }}
								exit={{ width: 0, opacity: 0 }}
								transition={{ duration: 0.24, ease: [0.2, 0, 0, 1] }}
								className="flex min-h-0 shrink-0 flex-col overflow-hidden border-l border-neutral-800"
							>
								<div className="flex h-8 shrink-0 items-center gap-1 border-b border-neutral-800 px-2">
									{(["files", "review", "commands", "tree"] as const).map((t) => (
										<button
											key={t}
											type="button"
											onClick={() => setDockTab(t)}
											className={`rounded px-2 py-0.5 text-[10px] capitalize ${
												dockTab === t
													? "bg-neutral-800 text-neutral-100"
													: "text-neutral-500 hover:text-neutral-300"
											}`}
										>
											{t === "review" ? `Review (${reviewCount})` : t}
										</button>
									))}
									<button
										type="button"
										onClick={() => setDockTab(null)}
										className="ml-auto px-1.5 text-neutral-600 hover:text-neutral-300"
									>
										×
									</button>
								</div>
								<div className="min-h-0 flex-1 overflow-y-auto">
									{dockTab === "files" && <FileExplorer cwd={active.cwd} />}
									{dockTab === "review" && <ReviewQueue blocks={active.blocks} />}
									{dockTab === "commands" && (
										<CommandsBrowser sessionId={active.id} onInsert={(text) => setInsertedText(text)} />
									)}
									{dockTab === "terminal" && (
									<div className="flex h-full flex-col">
										{/* Terminal tab bar */}
										<div className="flex h-7 shrink-0 items-center gap-0.5 border-b border-neutral-800 px-1">
											{terminalTabs.map((tab, i) => (
												<button
													key={tab.id}
													type="button"
													onClick={() => setActiveTermTab(i)}
													className={`group flex items-center gap-1 rounded px-2 py-0.5 text-[10px] ${
														i === activeTermTab
															? "bg-neutral-800 text-neutral-100"
															: "text-neutral-500 hover:text-neutral-300"
													}`}
												>
													{tab.label}
													<span
														role="button"
														tabIndex={0}
														onClick={(e) => {
															e.stopPropagation();
															if (terminalTabs.length > 1) {
																setTerminalTabs((prev) => prev.filter((_, j) => j !== i));
																setActiveTermTab((prev) => Math.min(prev, terminalTabs.length - 2));
															}
														}}
														onKeyDown={(e) => {
															if (e.key === "Enter" && terminalTabs.length > 1) {
																setTerminalTabs((prev) => prev.filter((_, j) => j !== i));
															}
														}}
														className="ml-0.5 text-neutral-600 hover:text-red-400"
													>
														×
													</span>
												</button>
											))}
											<button
												type="button"
												data-testid="add-terminal"
												onClick={() => {
													const num = nextTermNum;
													setTerminalTabs((prev) => [...prev, { id: `term-${num}-${Date.now()}`, label: `Terminal ${num}` }]);
													setActiveTermTab(terminalTabs.length);
													setNextTermNum(num + 1);
												}}
												className="rounded px-1.5 py-0.5 text-[10px] text-neutral-500 hover:bg-neutral-800 hover:text-neutral-300"
												title="New terminal"
											>
												+
											</button>
										</div>
										<div className="min-h-0 flex-1">
											<TerminalPanel
												key={terminalTabs[activeTermTab]?.id ?? "term-1"}
												cwd={active.cwd}
											/>
										</div>
									</div>
								)}
								{dockTab === "tree" && (
										<SessionTreePanel
											sessionId={active.id}
											refreshKey={treeRefreshKey}
											onNavigate={(entryId, summarize, instructions) => {
												void window.piDesktop
													.invoke({
														type: "session.navigate",
														sessionId: active.id,
														entryId,
														...(summarize ? { summarize: true } : {}),
														...(instructions.length > 0
															? { customInstructions: instructions }
															: {}),
													})
													.then((r) => {
														if (!r.ok) pushErrorNotice(active.id, r.error.message);
														else setTreeRefreshKey((k) => k + 1);
													});
											}}
											onFork={(entryId) => {
												void window.piDesktop
													.invoke({
														type: "session.fork",
														sessionId: active.id,
														entryId,
													})
													.then((r) => {
														if (!r.ok) pushErrorNotice(active.id, r.error.message);
														else setTreeRefreshKey((k) => k + 1);
													});
											}}
										/>
									)}
								</div>
							</motion.div>
							</AnimatePresence>
						)}
					</div>


					{/* Bottom control row */}
					<div className="flex items-center gap-2 border-t border-neutral-800 px-3 py-1">
						<button
							type="button"
							disabled={active.phase !== "idle"}
							onClick={() => setCompactOpen(true)}
							className="rounded px-2 py-0.5 text-[10px] text-neutral-500 hover:text-neutral-300 disabled:opacity-40"
							title="Summarize older context to free window space"
						>
							Compact…
						</button>
						<select
							onChange={(e) => {
								const action = e.target.value;
								e.target.selectedIndex = 0;
								if (action === "") return;
								void window.piDesktop
									.invoke(
										action === "html"
											? { type: "session.export_html", sessionId: active.id }
											: { type: "session.export_jsonl", sessionId: active.id }
									)
									.then((r) => {
										if (!r.ok) pushErrorNotice(active.id, r.error.message);
									});
							}}
							defaultValue=""
							className="rounded bg-transparent px-1 py-0.5 text-[10px] text-neutral-500 hover:text-neutral-300"
							title="Export session"
						>
							<option value="" disabled>Export…</option>
							<option value="html">HTML</option>
							<option value="jsonl">JSONL</option>
						</select>
						<button
							type="button"
							data-testid="toggle-terminal"
							onClick={() => setDockTab((prev) => (prev === "terminal" ? null : "terminal"))}
							className={`rounded px-2 py-0.5 text-[10px] ${
								dockTab === "terminal"
									? "bg-neutral-800 text-blue-400"
									: "text-neutral-500 hover:text-neutral-300"
							}`}
						>
							Terminal
						</button>
					</div>

					<Composer
						insertText={insertedText}
						onInsertHandled={() => setInsertedText(null)}
						streaming={active.phase !== "idle"}
						queueCount={active.queue.steering.length + active.queue.followUp.length}
						projectRoot={active.cwd}
						onOpenPalette={() => setDockTab("commands")}
						onOpenReview={() => setDockTab("review")}
						modelName={active.model?.name}
						onSend={send}
						onBash={runBash}
						onAbort={() => {
							if (activeId !== null) {
								void window.piDesktop.invoke({
									type: "session.abort",
									sessionId: activeId,
								});
							}
						}}
					/>

					<StatusBar
						session={active}
						onCycleModel={() => {
							void window.piDesktop
								.invoke({ type: "session.cycle_model", sessionId: active.id })
								.then((r) => {
									if (!r.ok) pushErrorNotice(active.id, r.error.message);
									else refreshState(active.id);
								});
						}}
						onSetThinkingLevel={(level) => {
							void window.piDesktop.invoke({
								type: "session.set_thinking",
								sessionId: active.id,
								level,
							});
						}}
					/>

					{compactOpen && (
						<div className="absolute inset-0 z-50 flex items-center justify-center bg-black/60">
							<div className="w-[420px] rounded-xl border border-neutral-700 bg-neutral-900 p-5">
								<h3 className="mb-1 text-sm font-semibold text-neutral-100">
									Compact context
								</h3>
								<p className="mb-3 text-xs text-neutral-400">
									Summarizes older messages to free context window space. Recent work is
									preserved.
								</p>
								<textarea
									value={compactInstructions}
									onChange={(e) => setCompactInstructions(e.target.value)}
									rows={3}
									placeholder="Optional instructions for the summary…"
									className="mb-4 w-full resize-none rounded border border-neutral-700 bg-neutral-950 px-3 py-2 text-xs outline-none focus:border-blue-500"
								/>
								<div className="flex justify-end gap-2">
									<button
										type="button"
										onClick={() => setCompactOpen(false)}
										className="rounded bg-neutral-800 px-3 py-1.5 text-xs hover:bg-neutral-700"
									>
										Cancel
									</button>
									<button
										type="button"
										data-testid="compact-confirm"
										disabled={compacting}
										onClick={() => {
											setCompacting(true);
											void window.piDesktop
												.invoke({
													type: "session.compact",
													sessionId: active.id,
													...(compactInstructions.length > 0
														? { customInstructions: compactInstructions }
														: {}),
												})
												.then((r) => {
													setCompacting(false);
													if (!r.ok) {
														pushErrorNotice(active.id, r.error.message);
													} else {
														const data = r.data as {
															tokensBefore?: number;
															estimatedTokensAfter?: number;
														};
														useSessions
															.getState()
															.pushNotice(
																active.id,
																`Context compacted: ${String(data?.tokensBefore ?? "?")} → ${String(data?.estimatedTokensAfter ?? "?")} tokens.`,
																"info"
															);
													}
													setCompactOpen(false);
													setCompactInstructions("");
													refreshState(active.id);
												});
										}}
										className="rounded bg-purple-700 px-3 py-1.5 text-xs text-white hover:bg-purple-600 disabled:opacity-40"
									>
										{compacting ? "Compacting…" : "Compact"}
									</button>
								</div>
							</div>
						</div>
					)}

					{active.pendingDialog !== undefined && (
						<DialogModal
							request={active.pendingDialog}
							onAnswer={(response) => {
								void window.piDesktop.invoke({
									type: "session.respond_ui",
									sessionId: active.id,
									...response,
								});
								useSessions.setState((prev) => {
									const s = prev.sessions[active.id];
									if (s === undefined) return prev;
									const { pendingDialog: _cleared, ...rest } = s;
									void _cleared;
									return {
										sessions: { ...prev.sessions, [active.id]: rest },
									};
								});
							}}
						/>
					)}

					{active.dead !== undefined && (
						<div className="flex items-center gap-2 border-t border-red-900 bg-red-950/60 px-4 py-2 text-xs text-red-300">
							<span className="flex-1">Backend died: {active.dead}</span>
							<button
								type="button"
								onClick={() => {
									void window.piDesktop
										.invoke({
											type: "session.create",
											cwd: active.cwd,
											backend: active.backend,
										})
										.then((r) => {
											if (r.ok) open(r.data);
										});
								}}
								className="rounded bg-red-800 px-2.5 py-0.5 text-[10px] text-white hover:bg-red-700"
							>
								Reconnect
							</button>
						</div>
					)}
				</>
			)}
		</div>
	);
}
