/**
 * Chat page: session tabs, transcript, composer, status bar, dialog modal.
 */
import { useState } from "react";
import type { PiImageInput } from "../../../shared/pi";
import { useSessions } from "../stores/pi-sessions";
import { CommandsBrowser, FileExplorer, ReviewQueue } from "../components/workspace/Dock";
import { TerminalPanel } from "../components/workspace/TerminalPanel";
import { Transcript } from "../components/chat/Transcript";
import { Composer } from "../components/chat/Composer";
import { StatusBar } from "../components/chat/StatusBar";
import { DialogModal } from "../components/chat/DialogModal";

export function ChatPage(): React.JSX.Element {
	const sessions = useSessions((s) => s.sessions);
	const activeId = useSessions((s) => s.activeId);
	const open = useSessions((s) => s.open);
	const closeTab = useSessions((s) => s.close);
	const setActive = useSessions((s) => s.setActive);
	const addUserBlock = useSessions((s) => s.addUserBlock);
	const pushErrorNotice = useSessions((s) => s.pushErrorNotice);
	const [creating, setCreating] = useState(false);
	const [createError, setCreateError] = useState<string | null>(null);
	const [dockTab, setDockTab] = useState<"files" | "review" | "commands" | null>(null);
	const [terminalOpen, setTerminalOpen] = useState(false);

	const sessionList = Object.values(sessions);
	const active = activeId !== null ? sessions[activeId] : undefined;
	const reviewCount =
		active?.blocks.filter(
			(b) => b.kind === "tool" && ["edit", "write"].includes(b.toolName)
		).length ?? 0;
	const [insertedText, setInsertedText] = useState<string | null>(null);

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
		void window.piDesktop
			.invoke({
				type: "session.prompt",
				sessionId: activeId,
				text,
				...(images.length > 0 ? { images } : {}),
				...(streamingBehavior !== undefined ? { streamingBehavior } : {}),
			})
			.then((result) => {
				if (!result.ok) pushErrorNotice(activeId, `Prompt rejected: ${result.error.message}`);
			});
	}

	return (
		<div className="flex h-full flex-col">
			{/* Session tabs */}
			<div className="flex h-9 shrink-0 items-center gap-1 border-b border-neutral-800 px-2">
				{createError !== null && (
				<span className="truncate rounded bg-red-950/70 px-2 py-0.5 text-[10px] text-red-300">
					{createError}
					<button type="button" onClick={() => setCreateError(null)} className="ml-1 text-red-400">×</button>
				</span>
			)}
			{sessionList.map((s) => (
					<button
						key={s.id}
						type="button"
						onClick={() => setActive(s.id)}
						className={`group flex items-center gap-1.5 rounded-t px-3 py-1.5 text-xs ${
							s.id === activeId
								? "bg-neutral-800 text-neutral-100"
								: "text-neutral-500 hover:text-neutral-300"
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
							className="ml-1 hidden text-neutral-600 hover:text-neutral-300 group-hover:inline"
						>
							×
						</span>
					</button>
				))}
				<button
					type="button"
					disabled={creating}
					onClick={() => void newSession("sdk")}
					className="rounded px-2 py-1 text-xs text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200 disabled:opacity-40"
				>
					+ SDK
				</button>
				<button
					type="button"
					disabled={creating}
					onClick={() => void newSession("rpc")}
					className="rounded px-2 py-1 text-xs text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200 disabled:opacity-40"
				>
					+ RPC
				</button>
			</div>

			{active === undefined ? (
				<div className="flex flex-1 flex-col items-center justify-center gap-3">
					<p className="text-sm text-neutral-400">No open sessions.</p>
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
					<div className="flex min-h-0 flex-1">
						<div className="flex min-w-0 flex-1 flex-col">
							<Transcript blocks={active.blocks} phase={active.phase} />
						</div>
						{dockTab !== null && (
							<div className="w-72 shrink-0 overflow-hidden border-l border-neutral-800">
								<div className="flex h-8 items-center gap-1 border-b border-neutral-800 px-2">
									{(["files", "review", "commands"] as const).map((t) => (
										<button
											key={t}
											type="button"
											onClick={() => setDockTab(t)}
											className={`rounded px-2 py-0.5 text-[10px] capitalize ${
												dockTab === t ? "bg-neutral-800 text-neutral-100" : "text-neutral-500 hover:text-neutral-300"
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
								<div className="h-[calc(100%-2rem)] overflow-y-auto">
									{dockTab === "files" && <FileExplorer cwd={active.cwd} />}
									{dockTab === "review" && <ReviewQueue blocks={active.blocks} />}
									{dockTab === "commands" && <CommandsBrowser sessionId={active.id} onInsert={(text) => setInsertedText(text)} />}
								</div>
							</div>
						)}
					</div>
					{terminalOpen && (
						<div className="h-56 shrink-0 border-t border-neutral-800 bg-black">
							<TerminalPanel cwd={active.cwd} />
						</div>
					)}
					<div className="flex items-center gap-2 border-t border-neutral-800 px-3 py-1">
						<button
							type="button"
							onClick={() => setDockTab(dockTab === "files" ? null : "files")}
							className={`rounded px-2 py-0.5 text-[10px] ${dockTab === "files" ? "bg-neutral-800 text-neutral-100" : "text-neutral-500 hover:text-neutral-300"}`}
						>
							Files
						</button>
						<button
							type="button"
							onClick={() => setDockTab(dockTab === "review" ? null : "review")}
							className={`rounded px-2 py-0.5 text-[10px] ${dockTab === "review" ? "bg-neutral-800 text-neutral-100" : "text-neutral-500 hover:text-neutral-300"}`}
						>
							Review ({reviewCount})
						</button>
						<button
							type="button"
							onClick={() => setDockTab(dockTab === "commands" ? null : "commands")}
							className={`rounded px-2 py-0.5 text-[10px] ${dockTab === "commands" ? "bg-neutral-800 text-neutral-100" : "text-neutral-500 hover:text-neutral-300"}`}
						>
							Commands
						</button>
						<button
							type="button"
							onClick={() => setTerminalOpen((v) => !v)}
							data-testid="toggle-terminal"
							className={`ml-auto rounded px-2 py-0.5 text-[10px] ${terminalOpen ? "bg-neutral-800 text-neutral-100" : "text-neutral-500 hover:text-neutral-300"}`}
						>
							Terminal
						</button>
					</div>
					<Composer
						insertText={insertedText}
						onInsertHandled={() => setInsertedText(null)}
						streaming={active.phase !== "idle"}
						queueCount={active.queue.steering.length + active.queue.followUp.length}
						onSend={send}
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
						onSetThinkingLevel={(level) => {
							void window.piDesktop.invoke({
								type: "session.set_thinking",
								sessionId: active.id,
								level,
							});
						}}
					/>
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
						<div className="border-t border-red-900 bg-red-950/60 px-4 py-2 text-xs text-red-300">
							Backend died: {active.dead}
						</div>
					)}
				</>
			)}
		</div>
	);
}
