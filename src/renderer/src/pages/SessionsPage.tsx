/**
 * Sessions browser (chapters 4+5): indexed sessions with FTS search via the
 * Python sidecar (graceful LIKE fallback), resume/delete, usage panel fed by
 * sidecar analytics when healthy.
 */
import { useCallback, useEffect, useState } from "react";
import type { SidecarSearchHit, SessionOpenedResponse } from "../../../shared/pi";
import { ensureProjectTrust } from "../lib/trust";

interface IndexedSession {
	id: string;
	filePath: string;
	name: string | null;
	cwd: string | null;
	updatedAt: number | null;
	messageCount: number;
	inputTokens: number;
	outputTokens: number;
	costUsd: number;
	modelProvider: string | null;
	modelId: string | null;
	firstMessage: string | null;
}

interface DailyUsage {
	day: string;
	input_tokens: number;
	output_tokens: number;
	cost_usd: number;
	requests: number;
}

/** Row of the sidecar's /analytics/top-sessions aggregation. */
interface TopSessionRow {
	id: string | null;
	name: string | null;
	cwd: string | null;
	tokens: number;
	cost_usd: number;
}

type SidecarStatus = "starting" | "healthy" | "degraded" | "stopped";

function relTime(ts: number | null): string {
	if (ts === null || ts === 0) return "—";
	const diff = Date.now() - ts;
	if (diff < 60_000) return "just now";
	if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
	if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
	return `${Math.floor(diff / 86_400_000)}d ago`;
}

export function SessionsPage({
	onResume,
}: {
	onResume?(response: SessionOpenedResponse): void;
}): React.JSX.Element {
	const [sessions, setSessions] = useState<IndexedSession[]>([]);
	const [query, setQuery] = useState("");
	const [usage, setUsage] = useState<DailyUsage[]>([]);
	const [totals, setTotals] = useState<{ totalCost: number; totalTokens: number }>({
		totalCost: 0,
		totalTokens: 0,
	});
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [sidecarStatus, setSidecarStatus] = useState<SidecarStatus>("stopped");
	const [hits, setHits] = useState<SidecarSearchHit[] | null>(null);
	const [top, setTop] = useState<TopSessionRow[]>([]);

	useEffect(() => {
		return window.piDesktop.on((event) => {
			if (event.type === "sidecar_status") setSidecarStatus(event.status);
		});
	}, []);

	const load = useCallback(async (q: string): Promise<void> => {
		const result = await window.piDesktop.invoke({
			type: "db.sessions.search",
			query: q,
		});
		if (result.ok) setSessions(result.data.sessions);
	}, []);

	const loadUsage = useCallback(async (): Promise<void> => {
		// Prefer sidecar analytics; fall back to local SQL aggregation.
		const sidecarUsage = await window.piDesktop.invoke({
			type: "sidecar.usage",
			days: 14,
		});
		if (sidecarUsage.ok && sidecarUsage.data !== null) {
			setUsage(sidecarUsage.data as unknown as DailyUsage[]);
		} else {
			const local = await window.piDesktop.invoke({ type: "db.usage.daily", days: 14 });
			if (local.ok) {
				setUsage(
					(local.data as Array<{ day: string; inputTokens: number; outputTokens: number; costUsd: number; requests: number }>).map(
						(r) => ({
							day: r.day,
							input_tokens: r.inputTokens,
							output_tokens: r.outputTokens,
							cost_usd: r.costUsd,
							requests: r.requests,
						})
					)
				);
			}
		}
		const total = await window.piDesktop.invoke({ type: "db.usage.totals" });
		if (total.ok) setTotals(total.data);
		// Top sessions come from the sidecar's FTS/analytics tables only; the
		// panel simply stays hidden when the sidecar is not running.
		const topResult = await window.piDesktop.invoke({ type: "sidecar.top", by: "cost", limit: 5 });
		if (topResult.ok && topResult.data !== null) {
			setTop(topResult.data as unknown as TopSessionRow[]);
		} else {
			setTop([]);
		}
	}, []);

	useEffect(() => {
		let cancelled = false;
		// Debounce like the Sidebar's 200 ms: two IPCs per raw keystroke was
		// hammering both the local DB and the sidecar (audit 6 L-12).
		const debounce = setTimeout(() => {
			void (async () => {
				await load(query);
				if (cancelled) return;
				if (query.trim().length === 0) {
					setHits(null);
					return;
				}
				const sidecarResult = await window.piDesktop.invoke({
					type: "sidecar.search",
					query,
				});
				if (cancelled) return;
				if (sidecarResult.ok && sidecarResult.data !== null) {
					setHits((sidecarResult.data as { hits: SidecarSearchHit[] }).hits);
				} else {
					setHits(null); // sidecar unavailable — LIKE fallback already applied
				}
			})();
		}, 200);
		return () => {
			cancelled = true;
			clearTimeout(debounce);
		};
	}, [query, load]);

	async function refreshAll(): Promise<void> {
		setBusy(true);
		try {
			await window.piDesktop.invoke({ type: "db.indexer.refresh" });
			await window.piDesktop.invoke({ type: "sidecar.rebuild" });
			await load(query);
			await loadUsage();
		} finally {
			setBusy(false);
		}
	}

	async function resume(session: IndexedSession): Promise<void> {
		setBusy(true);
		try {
			if (session.cwd !== null && !(await ensureProjectTrust(session.cwd))) return;
			const result = await window.piDesktop.invoke({
				type: "session.resume",
				sessionPath: session.filePath,
				...(session.cwd !== null ? { cwd: session.cwd } : {}),
			});
			if (result.ok) {
				onResume?.(result.data);
			} else {
				// Surface the failure instead of a no-op click (audit 5 M-7).
				setError(result.error.message);
			}
		} finally {
			setBusy(false);
		}
	}

	/**
	 * Open an FTS message-match hit (audit 6 L-15). The hit matched message
	 * TEXT; the LIKE metadata search below may not list the session at all, so
	 * a bare sessions.find() silently no-oped. Fall back to an id lookup over
	 * the full index, and say something when the row is genuinely gone.
	 */
	async function openHit(hit: SidecarSearchHit): Promise<void> {
		const listed = sessions.find((s) => s.id === hit.session_id);
		if (listed !== undefined) {
			await resume(listed);
			return;
		}
		const all = await window.piDesktop.invoke({ type: "db.sessions.list", limit: 500 });
		const row = all.ok
			? (all.data.sessions as IndexedSession[]).find((s) => s.id === hit.session_id)
			: undefined;
		if (row !== undefined) {
			await resume(row);
		} else {
			setError("That session is no longer indexed — press Refresh and try again.");
		}
	}

	async function remove(session: IndexedSession): Promise<void> {
		// The delete can now be refused (unindexed path, or the session is open) —
		// surface the reason instead of silently keeping the row (audit 6 H-5).
		const result = await window.piDesktop.invoke({
			type: "session.delete_file",
			sessionPath: session.filePath,
		});
		if (!result.ok) {
			setError(result.error.message);
			return;
		}
		// Drop its FTS hits too, or they stay behind as dead clicks (L-15).
		setHits((prev) => prev?.filter((h) => h.session_id !== session.id) ?? prev);
		await load(query);
	}

	const statusCls =
		sidecarStatus === "healthy"
			? "bg-green-600"
			: sidecarStatus === "starting"
				? "bg-amber-500 animate-pulse"
				: "bg-neutral-600";

	return (
		<div className="flex h-full overflow-hidden">
			<div className="flex flex-1 flex-col">
				<div className="flex items-center gap-2 border-b border-neutral-800 p-3">
					<input
						value={query}
						onChange={(e) => setQuery(e.target.value)}
						placeholder="Search sessions…"
						className="flex-1 rounded border border-neutral-700 bg-neutral-900 px-3 py-1.5 text-sm outline-none focus:border-blue-500"
					/>
					<span
						title={`sidecar: ${sidecarStatus}`}
						className={`flex items-center gap-1 rounded px-2 py-1 font-mono text-[10px] text-neutral-400`}
					>
						<span className={`h-1.5 w-1.5 rounded-full ${statusCls}`} />
						{sidecarStatus}
					</span>
					<button
						type="button"
						disabled={busy}
						onClick={() => void refreshAll().catch(() => {})}
						className="rounded bg-neutral-800 px-3 py-1.5 text-xs text-neutral-300 hover:bg-neutral-700 disabled:opacity-40"
					>
						Refresh
					</button>
				</div>

				{error !== null && (
					<div className="mx-3 mt-3 rounded border border-danger/40 bg-danger-soft/50 px-3 py-2 text-xs text-red-300">
						{error}
					</div>
				)}

				{/* FTS hits (sidecar) */}
				{hits !== null && hits.length > 0 && (
					<div className="border-b border-neutral-800 bg-app-surface/40">
						<div className="px-4 pt-2 text-[10px] tracking-wide text-neutral-500 uppercase">
							Message matches
						</div>
						{hits.slice(0, 10).map((hit) => (
							<button
								key={`${hit.session_id}-${hit.entry_id}`}
								type="button"
								onClick={() => void openHit(hit).catch(() => {})}
								className="block w-full px-4 py-2 text-left hover:bg-neutral-900"
							>
								<div className="break-words text-xs text-neutral-300">
								{hit.segments.map((seg, i) =>
									seg.match ? (
										<mark
											key={i}
											className="rounded-sm bg-blue-900 px-0.5 text-on-accent-soft"
										>
											{seg.text}
										</mark>
									) : (
										<span key={i}>{seg.text}</span>
									)
								)}
							</div>
								<div className="mt-0.5 font-mono text-[10px] text-neutral-600">
									{hit.session_name ?? hit.session_id ?? "?"} · {hit.role}
								</div>
							</button>
						))}
					</div>
				)}

				<div className="flex-1 overflow-y-auto">
					{sessions.length === 0 ? (
						<div className="flex h-full items-center justify-center text-sm text-neutral-600">
							No sessions indexed yet.
						</div>
					) : (
						sessions.map((s) => (
							<div
								key={s.id}
								className="flex items-center gap-3 border-b border-neutral-800/60 px-4 py-2.5 hover:bg-app-surface/50"
							>
								<div className="min-w-0 flex-1">
									<div className="flex items-center gap-2">
										<span className="truncate text-sm text-neutral-200">
											{s.name ?? s.firstMessage ?? s.filePath.split("/").pop()}
										</span>
										{s.modelId !== null && (
											<span className="rounded bg-neutral-800 px-1.5 py-0.5 font-mono text-[9px] text-neutral-500">
												{s.modelProvider}/{s.modelId}
											</span>
										)}
									</div>
									<div className="mt-0.5 truncate font-mono text-[10px] text-neutral-600">
										{s.cwd ?? "?"} · {relTime(s.updatedAt)} · {s.messageCount} msgs
									</div>
								</div>
								{s.costUsd > 0 && (
									<span className="font-mono text-[10px] text-neutral-500">
										${s.costUsd.toFixed(4)}
									</span>
								)}
								<button
									type="button"
									disabled={busy}
									onClick={() => void resume(s).catch(() => {})}
									className="rounded bg-blue-700 px-2.5 py-1 text-[10px] text-on-accent hover:bg-blue-600 disabled:opacity-40"
								>
									Resume
								</button>
								<button
									type="button"
									disabled={busy}
									onClick={() => void remove(s).catch(() => {})}
									className="rounded px-2 py-1 text-[10px] text-neutral-500 hover:bg-danger-soft hover:text-danger"
								>
									Delete
								</button>
							</div>
						))
					)}
				</div>
			</div>

			{/* Usage panel */}
			<div className="w-72 shrink-0 border-l border-neutral-800 p-4">
				<h3 className="mb-3 text-xs font-semibold tracking-wide text-neutral-400 uppercase">
					Usage (14 days)
				</h3>
				<div className="mb-4 rounded-lg border border-neutral-800 bg-app-surface/50 p-3">
					<div className="text-lg font-semibold text-neutral-100">
						${totals.totalCost.toFixed(4)}
					</div>
					<div className="font-mono text-[10px] text-neutral-500">
						{totals.totalTokens.toLocaleString()} tokens all-time
					</div>
				</div>
				{usage.length === 0 ? (
					<p className="text-xs text-neutral-600">No usage recorded yet.</p>
				) : (
					<div className="flex flex-col gap-1.5">
						{usage.map((u) => {
							const max = Math.max(...usage.map((x) => x.cost_usd), 0.0001);
							const width = Math.max(2, Math.round((u.cost_usd / max) * 100));
							return (
								<div key={u.day}>
									<div className="flex justify-between font-mono text-[10px] text-neutral-500">
										<span>{u.day}</span>
										<span>${u.cost_usd.toFixed(4)}</span>
									</div>
									<div className="mt-0.5 h-1 rounded bg-neutral-800">
										<div className="h-1 rounded bg-blue-600" style={{ width: `${width}%` }} />
									</div>
								</div>
							);
						})}
					</div>
				)}
				{top.length > 0 && (
					<div className="mt-4">
						<h3 className="mb-2 text-xs font-semibold tracking-wide text-neutral-400 uppercase">
							Top sessions
						</h3>
						<div className="flex flex-col gap-1">
							{top.map((t) => {
								const target = t.id !== null ? sessions.find((s) => s.id === t.id) : undefined;
								return (
									<button
										key={t.id ?? t.cwd ?? t.name}
										type="button"
										disabled={target === undefined}
										onClick={() => target !== undefined && void resume(target).catch(() => {})}
										title={target !== undefined ? "Resume this session" : (t.cwd ?? undefined)}
										className="flex items-center gap-2 rounded px-1 py-0.5 text-left hover:bg-neutral-900 disabled:cursor-default"
									>
										<span className="min-w-0 flex-1 truncate text-[11px] text-neutral-300">
											{t.name ?? t.cwd?.split("/").pop() ?? "session"}
										</span>
										<span className="shrink-0 font-mono text-[10px] text-neutral-500">
											${t.cost_usd.toFixed(4)}
										</span>
									</button>
								);
							})}
						</div>
					</div>
				)}
			</div>
		</div>
	);
}
