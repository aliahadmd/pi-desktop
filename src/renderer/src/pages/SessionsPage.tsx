/**
 * Sessions browser (chapters 4+5): indexed sessions with FTS search via the
 * Python sidecar (graceful LIKE fallback), resume/delete, usage panel fed by
 * sidecar analytics when healthy.
 */
import { useCallback, useEffect, useState } from "react";
import type { SidecarSearchHit, SessionOpenedResponse } from "../../../shared/pi";

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
	const [sidecarStatus, setSidecarStatus] = useState<SidecarStatus>("stopped");
	const [hits, setHits] = useState<SidecarSearchHit[] | null>(null);

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
	}, []);

	useEffect(() => {
		let cancelled = false;
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
		return () => {
			cancelled = true;
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
			const result = await window.piDesktop.invoke({
				type: "session.resume",
				sessionPath: session.filePath,
				...(session.cwd !== null ? { cwd: session.cwd } : {}),
			});
			if (result.ok) {
				onResume?.(result.data);
			}
		} finally {
			setBusy(false);
		}
	}

	async function remove(session: IndexedSession): Promise<void> {
		await window.piDesktop.invoke({
			type: "session.delete_file",
			sessionPath: session.filePath,
		});
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
						onClick={() => void refreshAll()}
						className="rounded bg-neutral-800 px-3 py-1.5 text-xs text-neutral-300 hover:bg-neutral-700 disabled:opacity-40"
					>
						Refresh
					</button>
				</div>

				{/* FTS hits (sidecar) */}
				{hits !== null && hits.length > 0 && (
					<div className="border-b border-neutral-800 bg-neutral-900/40">
						<div className="px-4 pt-2 text-[10px] tracking-wide text-neutral-500 uppercase">
							Message matches
						</div>
						{hits.slice(0, 10).map((hit) => (
							<button
								key={`${hit.session_id}-${hit.entry_id}`}
								type="button"
								onClick={() => {
									const target = sessions.find((s) => s.id === hit.session_id);
									if (target !== undefined) void resume(target);
								}}
								className="block w-full px-4 py-2 text-left hover:bg-neutral-900"
							>
								<div
									className="text-xs text-neutral-300 [&_mark]:bg-blue-900 [&_mark]:text-blue-200"
									dangerouslySetInnerHTML={{ __html: hit.snippet }}
								/>
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
								className="flex items-center gap-3 border-b border-neutral-800/60 px-4 py-2.5 hover:bg-neutral-900/50"
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
									onClick={() => void resume(s)}
									className="rounded bg-blue-700 px-2.5 py-1 text-[10px] text-white hover:bg-blue-600 disabled:opacity-40"
								>
									Resume
								</button>
								<button
									type="button"
									disabled={busy}
									onClick={() => void remove(s)}
									className="rounded px-2 py-1 text-[10px] text-neutral-500 hover:bg-red-950 hover:text-red-400"
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
				<div className="mb-4 rounded-lg border border-neutral-800 bg-neutral-900/50 p-3">
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
			</div>
		</div>
	);
}
