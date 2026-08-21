/**
 * Chapter 2 debug console: minimal surface to drive a pi session end-to-end
 * (create → prompt → stream → abort) and observe the raw event flow.
 * Chapter 3 replaces this with the real chat experience.
 */
import { useEffect, useRef, useState } from "react";
import type { PiEvent, PiSessionState } from "../../shared/pi";
import type { SessionOpenedResponse } from "../../shared/pi";

interface LogLine {
	ts: number;
	text: string;
}

export default function PiConsole(): React.JSX.Element {
	const [session, setSession] = useState<SessionOpenedResponse | null>(null);
	const [state, setState] = useState<PiSessionState | null>(null);
	const [log, setLog] = useState<LogLine[]>([]);
	const [input, setInput] = useState("");
	const [busy, setBusy] = useState(false);
	const logRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		const unsubscribe = window.piDesktop.on((event) => {
			if (event.type !== "pi_event") return;
			appendLog(`[${event.event.type}] ${summarizeEvent(event.event)}`);
		});
		return unsubscribe;
	}, []);

	useEffect(() => {
		logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
	}, [log]);

	function appendLog(text: string): void {
		setLog((prev) => [...prev.slice(-500), { ts: Date.now(), text }]);
	}

	async function pickAndCreate(backend: "sdk" | "rpc"): Promise<void> {
		const picked = await window.piDesktop.invoke({ type: "app_pick_directory" });
		if (!picked.ok || picked.data.path === null) return;
		setBusy(true);
		try {
			const result = await window.piDesktop.invoke({
				type: "session.create",
				cwd: picked.data.path,
				backend,
			});
			if (result.ok) {
				setSession(result.data);
				appendLog(`session opened (${result.data.backend}) in ${result.data.cwd}`);
				await refreshState(result.data.sessionId);
			} else {
				appendLog(`ERROR: ${result.error.code}: ${result.error.message}`);
			}
		} finally {
			setBusy(false);
		}
	}

	async function refreshState(sessionId: string): Promise<void> {
		const result = await window.piDesktop.invoke({
			type: "session.state",
			sessionId,
		});
		if (result.ok) setState(result.data);
	}

	async function send(): Promise<void> {
		if (session === null || input.trim().length === 0) return;
		const text = input;
		setInput("");
		setBusy(true);
		const result = await window.piDesktop.invoke({
			type: "session.prompt",
			sessionId: session.sessionId,
			text,
		});
		if (!result.ok) appendLog(`ERROR: ${result.error.message}`);
		setBusy(false);
		// Wait for settle, then refresh state
		setTimeout(() => void refreshState(session.sessionId), 500);
	}

	async function abort(): Promise<void> {
		if (session === null) return;
		await window.piDesktop.invoke({ type: "session.abort", sessionId: session.sessionId });
		appendLog("[abort requested]");
	}

	return (
		<div className="flex h-full flex-col gap-3 p-4">
			<div className="flex items-center gap-2">
				<button
					type="button"
					disabled={busy}
					onClick={() => void pickAndCreate("sdk")}
					className="rounded bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-500 disabled:opacity-50"
				>
					New SDK session…
				</button>
				<button
					type="button"
					disabled={busy}
					onClick={() => void pickAndCreate("rpc")}
					className="rounded bg-neutral-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-neutral-600 disabled:opacity-50"
				>
					New RPC session…
				</button>
				{session !== null && (
					<span className="ml-auto font-mono text-[10px] text-neutral-400">
						{session.backend} · {session.cwd} ·{" "}
						{state?.model !== undefined
							? `${state.model.provider}/${state.model.id}`
							: "no model"}
					</span>
				)}
			</div>

			{session !== null && (
				<div className="flex gap-2">
					<input
						value={input}
						onChange={(e) => setInput(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === "Enter" && !e.shiftKey) {
								e.preventDefault();
								void send();
							}
						}}
						placeholder="Prompt pi… (Enter to send)"
						className="flex-1 rounded border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm outline-none focus:border-blue-500"
					/>
					<button
						type="button"
						onClick={() => void abort()}
						className="rounded bg-red-800 px-3 py-2 text-xs text-white hover:bg-red-700"
					>
						Abort
					</button>
				</div>
			)}

			<div
				ref={logRef}
				data-testid="event-log"
				className="flex-1 overflow-y-auto rounded border border-neutral-800 bg-black/40 p-3 font-mono text-[11px] leading-relaxed text-neutral-300"
			>
				{log.length === 0 ? (
					<span className="text-neutral-500">
						Events appear here. Create a session to begin.
					</span>
				) : (
					log.map((line, i) => (
						<div key={`${line.ts}-${i}`} className="whitespace-pre-wrap">
							{line.text}
						</div>
					))
				)}
			</div>
		</div>
	);
}

function summarizeEvent(event: PiEvent): string {
	switch (event.type) {
		case "message_update": {
			const delta = event.delta as { type?: string; delta?: string };
			if (delta.type === "text_delta") return delta.delta ?? "";
			return JSON.stringify(delta).slice(0, 140);
		}
		case "tool_execution_start":
			return `${event.toolName} (${event.toolCallId})`;
		case "tool_execution_end":
			return `${event.toolName} done, isError=${String(event.isError)}`;
		case "backend_died":
			return event.reason;
		case "ui_dialog":
			return `${event.request.method}: ${event.request.title}`;
		default:
			return "";
	}
}
