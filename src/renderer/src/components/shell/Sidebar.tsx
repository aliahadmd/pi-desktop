/**
 * Sidebar (chapter 15): projects → sessions, search, live status dots,
 * new-session split button, footer sheet triggers.
 */
import { AnimatePresence, motion } from "motion/react";
import {
	ArrowUpDown,
	ChevronUp,
	FolderOpen,
	FolderPlus,
	Package,
	PanelLeftClose,
	PanelLeftOpen,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { sortProjects, type ProjectSortMode } from "../../lib/project-sort";
import { ProjectRow } from "./ProjectRow";
import { useSessions } from "../../stores/pi-sessions";

interface ProjectMeta {
	id: string;
	path: string;
	name: string;
	pinned: boolean;
	pinnedAt: number;
	sessionCount: number;
}

interface SidebarSession {
	id: string;
	filePath: string;
	name: string | null;
	cwd: string | null;
	updatedAt: number | null;
	messageCount: number;
	costUsd: number;
	firstMessage: string | null;
}

/** "ali ahad" → "AA"; single word → first two letters; empty → "?" */
function initialsOf(name: string): string {
	const parts = name.trim().split(/[\s._-]+/).filter((p) => p.length > 0);
	if (parts.length === 0) return "?";
	if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
	return (parts[0]![0]! + parts[1]![0]!).toUpperCase();
}

function relTime(ts: number | null): string {
	if (ts === null || ts === 0) return "—";
	const diff = Date.now() - ts;
	if (diff < 60_000) return "now";
	if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m`;
	if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h`;
	return `${Math.floor(diff / 86_400_000)}d`;
}

export function Sidebar({
	collapsed,
	onToggleCollapse,
	onOpenSession,
	onOpenSheet,
}: {
	collapsed: boolean;
	onToggleCollapse(): void;
	onOpenSession(response: import("../../../../shared/pi").SessionOpenedResponse): void;
	onOpenSheet(sheet: "models" | "settings" | "trust" | "browse" | "packages"): void;
}): React.JSX.Element {
	const [sessions, setSessions] = useState<SidebarSession[]>([]);
	const [filter, setFilter] = useState("");
	const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
	const [menuFor, setMenuFor] = useState<string | null>(null);
	const liveSessions = useSessions((s) => s.sessions);

	const load = useCallback(async (): Promise<void> => {
		const result = await window.piDesktop.invoke({
			type: "db.sessions.search",
			query: filter,
		});
		if (result.ok) setSessions(result.data.sessions);
	}, [filter]);

	useEffect(() => {
		void window.piDesktop.invoke({ type: "packages.list" }).then((r) => {
			if (r.ok) setInstalledCount(r.data.packages.length);
		});
		void window.piDesktop.invoke({ type: "app.user" }).then((r) => {
			if (r.ok) setUserName(r.data.name);
		});
	}, []);

	useEffect(() => {
		const debounce = setTimeout(() => void load(), 200);
		if (collapsed) return () => clearTimeout(debounce);
		const timer = setInterval(() => void load(), 10_000);
		return () => {
			clearTimeout(debounce);
			clearInterval(timer);
		};
	}, [filter, load, collapsed]);

	// Group by cwd
	const groups = useMemo(() => {
		const map = new Map<string, SidebarSession[]>();
		for (const s of sessions) {
			const key = s.cwd ?? "(unknown)";
			const list = map.get(key) ?? [];
			list.push(s);
			map.set(key, list);
		}
		return [...map.entries()].sort((a, b) => {
			const maxA = Math.max(...a[1].map((x) => x.updatedAt ?? 0));
			const maxB = Math.max(...b[1].map((x) => x.updatedAt ?? 0));
			return maxB - maxA;
		});
	}, [sessions]);

	// --- Phase 6: project metadata (pins, counts) + sorting -------------------
	const [projectMeta, setProjectMeta] = useState<ProjectMeta[]>([]);
	const [sortMode, setSortMode] = useState<ProjectSortMode>("recent");
	const [sortOpen, setSortOpen] = useState(false);

	useEffect(() => {
		void window.piDesktop
			.invoke({ type: "project.list" })
			.then((r) => {
				if (!r.ok) return;
				setProjectMeta(
					r.data.projects.map((p) => ({
						id: p.id,
						path: p.path,
						name: p.name ?? p.path.split("/").filter(Boolean).pop() ?? p.path,
						pinned: p.pinned,
						pinnedAt: /* not exposed over IPC; order arrives pre-sorted */ 0,
						sessionCount: p.sessionCount,
					})),
				);
			})
			.catch(() => {});
	}, [sessions]);

	useEffect(() => {
		void window.piDesktop
			.invoke({ type: "app.settings.get", key: "projectSort" })
			.then((r) => {
				if (r.ok && typeof r.data === "string") {
					setSortMode(r.data as ProjectSortMode);
				}
			})
			.catch(() => {});
	}, []);

	async function pickProject(): Promise<void> {
		const picked = await window.piDesktop.invoke({ type: "app_pick_directory" });
		if (!picked.ok || picked.data.path === null) return;
		const folder: string = picked.data.path;
		const r = await window.piDesktop.invoke({
			type: "project.create",
			path: folder,
		});
		if (!r.ok) return;
		setCollapsedGroups((prev) => {
			const next = new Set(prev);
			next.delete(folder);
			return next;
		});
	}

	async function createInProject(cwd: string): Promise<void> {
		setCreateError(null);
		const result = await window.piDesktop.invoke({
			type: "session.create",
			cwd,
			backend: "sdk",
		});
		if (!result.ok) {
			setCreateError(result.error.message);
			return;
		}
		const data = result.data as unknown as Parameters<typeof onOpenSession>[0];
		useSessions.getState().open(
			data as unknown as import("../../../../shared/pi").SessionOpenedResponse
		);
	}

	function togglePin(projectPath: string): void {
		const meta = projectMeta.find((m) => m.path === projectPath);
		if (meta === undefined) return; // unknown project (never opened via picker)
		const next = !meta.pinned;
		setProjectMeta((prev) =>
			prev.map((m) => (m.path === projectPath ? { ...m, pinned: next } : m)),
		);
		void window.piDesktop.invoke({
			type: "project.pin",
			projectId: meta.id,
			pinned: next,
		}).catch(() => {});
	}

	interface MergedGroup {
		key: string;
		name: string;
		list: SidebarSession[];
		pinned: boolean;
		pinnedAt: number;
		lastActivity: number;
		/** Store id when this group is a known project; undefined otherwise. */
		projectId?: string | undefined;
	}

	const mergedGroups = useMemo<MergedGroup[]>(() => {
		const byKey = new Map<string, MergedGroup>();
		for (const [key, list] of groups) {
			const meta = projectMeta.find((m) => m.path === key);
			byKey.set(key, {
				key,
				name: key.split("/").filter(Boolean).pop() ?? key,
				list,
				pinned: meta?.pinned ?? false,
				pinnedAt: meta?.pinnedAt ?? 0,
				lastActivity: Math.max(0, ...list.map((x) => x.updatedAt ?? 0)),
				...(meta !== undefined ? { projectId: meta.id } : {}),
			});
		}
		// Projects known to the store but without sessions still appear.
		for (const m of projectMeta) {
			if (!byKey.has(m.path)) {
				byKey.set(m.path, {
					key: m.path,
					name: m.name,
					list: [],
					pinned: m.pinned,
					pinnedAt: m.pinnedAt,
					lastActivity: 0,
					projectId: m.id,
				});
			}
		}
		return sortProjects(
			[...byKey.values()].map((g) => ({
				key: g.key,
				name: g.name,
				pinned: g.pinned,
				pinnedAt: g.pinnedAt,
				lastActivity: g.lastActivity,
				list: g.list,
				projectId: g.projectId,
			})),
			sortMode,
		);
	}, [groups, projectMeta, sortMode]);
	// ---------------------------------------------------------------------------

	async function openSession(s: SidebarSession): Promise<void> {
		// Already open? just focus.
		const existing = useSessions.getState().sessions[s.id];
		if (existing !== undefined) {
			useSessions.getState().setActive(s.id);
			return;
		}
		// Deduplicate rapid double-clicks (T19.4)
		if (resuming.has(s.id)) return;
		setResuming((prev) => new Set(prev).add(s.id));
		try {
			const result = await window.piDesktop.invoke({
				type: "session.resume",
				sessionPath: s.filePath,
				...(s.cwd !== null ? { cwd: s.cwd } : {}),
			});
			if (result.ok) onOpenSession(result.data as never);
		} finally {
			setResuming((prev) => {
				const next = new Set(prev);
				next.delete(s.id);
				return next;
			});
		}
	}

	function statusDot(id: string): "dead" | "streaming" | "idle" | null {
		const live = liveSessions[id];
		if (live === undefined) return null;
		if (live.dead !== undefined) return "dead";
		return live.phase === "idle" ? "idle" : "streaming";
	}

	const [createError, setCreateError] = useState<string | null>(null);
	const [installedCount, setInstalledCount] = useState(0);
	const [resuming, setResuming] = useState<Set<string>>(new Set());
	const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
	const [userName, setUserName] = useState("");
	// Profile footer menu (Models / Settings / Trust / History).
	const [profileMenuOpen, setProfileMenuOpen] = useState(false);

	async function create(backend: "sdk" | "rpc"): Promise<void> {
		setCreateError(null);
		const picked = await window.piDesktop.invoke({ type: "app_pick_directory" });
		if (!picked.ok || picked.data.path === null) return;
		const result = await window.piDesktop.invoke({
			type: "session.create",
			cwd: picked.data.path,
			backend,
		});
		if (!result.ok) {
			setCreateError(result.error.message);
			return;
		}
		const data = result.data as unknown as Parameters<typeof onOpenSession>[0];
		useSessions.getState().open(
			data as unknown as import("../../../../shared/pi").SessionOpenedResponse
		);
	}

	// Close the profile menu on Escape or any click outside the footer card.
	useEffect(() => {
		if (!profileMenuOpen) return;
		const onKey = (e: KeyboardEvent): void => {
			if (e.key === "Escape") setProfileMenuOpen(false);
		};
		const onClick = (e: MouseEvent): void => {
			const t = e.target as Element | null;
			if (t?.closest?.("[data-testid='sidebar-profile']") !== null) return;
			if (t?.closest?.("[data-testid='sidebar-profile-menu']") !== null) return;
			setProfileMenuOpen(false);
		};
		window.addEventListener("keydown", onKey);
		window.addEventListener("mousedown", onClick, true);
		return () => {
			window.removeEventListener("keydown", onKey);
			window.removeEventListener("mousedown", onClick, true);
		};
	}, [profileMenuOpen]);

	if (collapsed) {
		return (
			<div
				className="relative flex h-full flex-col items-center gap-2 border-r border-neutral-800 bg-neutral-950/60 pt-10"
				style={{ width: "var(--sidebar-rail-w)" }}
			>
				<div className="titlebar-drag absolute left-0 top-0 h-10 w-full" />
				<button
					type="button"
					title="Show sidebar (⌘\)"
					data-testid="sidebar-expand"
					onClick={onToggleCollapse}
					className="rounded p-1.5 text-neutral-500 hover:bg-neutral-900 hover:text-neutral-200"
				>
					<PanelLeftOpen size={14} strokeWidth={2} />
				</button>
				<button
					type="button"
					title="New session"
					onClick={() => void create("sdk")}
					className="rounded-lg bg-blue-600 p-1.5 text-white hover:bg-blue-500"
				>
					+
				</button>
				{sessions.slice(0, 8).map((s) => {
					const dot = statusDot(s.id);
					return (
						<span
							key={s.id}
							title={s.name ?? s.firstMessage ?? s.filePath}
							className={`h-2 w-2 rounded-full ${
								dot === "dead"
									? "bg-red-500"
									: dot === "streaming"
										? "bg-blue-500 animate-pulse"
										: "bg-neutral-600"
							}`}
						/>
					);
				})}
			</div>
		);
	}

	return (
		<div
			className="relative flex h-full flex-col border-r border-neutral-800 bg-neutral-950/60"
			style={{ width: "var(--sidebar-w)" }}
			data-testid="sidebar"
		>
			{/* New session */}
			<div className="titlebar-drag h-9 shrink-0" />
			<div className="px-2.5 pb-2.5">
				<div className="flex gap-1.5">
					<button
						type="button"
						data-testid="sidebar-new-sdk"
						onClick={() => void create("sdk")}
						className="flex-1 rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-500"
					>
						+ New session
					</button>
					<button
						type="button"
						title="New RPC session"
						onClick={() => void create("rpc")}
						className="rounded-lg bg-neutral-800 px-2.5 py-1.5 text-xs text-neutral-300 hover:bg-neutral-700"
					>
						RPC
					</button>
				</div>
				<input
					value={filter}
					onChange={(e) => setFilter(e.target.value)}
					placeholder="Search sessions…"
					className="mt-2 w-full rounded border border-neutral-800 bg-neutral-900 px-2.5 py-1.5 text-xs outline-none focus:border-blue-500"
				/>
			</div>

			{createError !== null && (
				<p className="mx-2.5 mb-1 rounded bg-red-950/70 px-2 py-1 text-[10px] text-red-300">
					{createError}
				</p>
			)}

			{/* Packages section */}
			<div className="px-1.5 pb-1">
				<button
					type="button"
					data-testid="sidebar-packages"
					onClick={() => onOpenSheet("packages")}
					className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs text-neutral-400 transition-standard hover:bg-neutral-900 hover:text-neutral-200"
				>
					<span className="text-neutral-400">
						<Package size={14} strokeWidth={1.75} />
					</span>
					<span>Packages</span>
					{installedCount > 0 && (
						<span className="ml-auto rounded-full bg-blue-950 px-1.5 text-[9px] font-medium text-blue-400">
							{installedCount}
						</span>
					)}
				</button>
			</div>

			{/* Projects header: label + sort + create/open */}
			<div className="flex items-center justify-between px-3 pt-2 pb-1">
				<span className="text-[9px] tracking-wide text-neutral-700 uppercase">Projects</span>
				<div className="relative flex items-center gap-0.5">
					<button
						type="button"
						title={`Sort: ${sortMode}`}
						data-testid="project-sort"
						onClick={() => setSortOpen((v) => !v)}
						className="rounded p-1 text-neutral-600 hover:bg-neutral-900 hover:text-neutral-300"
					>
						<ArrowUpDown size={11} strokeWidth={2} />
					</button>
					{sortOpen && (
						<div
							className="absolute right-0 top-full z-50 mt-1 w-36 overflow-hidden rounded-md border border-neutral-700 bg-neutral-900 py-1 shadow-xl"
							role="menu"
						>
							{(["recent", "name", "pinned"] as const).map((m) => (
								<button
									key={m}
									type="button"
									role="menuitem"
									onClick={() => {
										setSortMode(m);
										void window.piDesktop.invoke({
											type: "app.settings.set",
											key: "projectSort",
											value: JSON.stringify(m),
										});
										setSortOpen(false);
									}}
									className={`block w-full px-3 py-1 text-left text-xs hover:bg-neutral-800 ${
										sortMode === m ? "text-blue-400" : "text-neutral-300"
									}`}
								>
									{m === "recent" ? "Recent" : m === "name" ? "Name" : "Pinned"}
								</button>
							))}
						</div>
					)}
					<button
						type="button"
						title="Create project from new folder…"
						data-testid="project-create"
						onClick={() => void pickProject()}
						className="rounded p-1 text-neutral-600 hover:bg-neutral-900 hover:text-neutral-300"
					>
						<FolderPlus size={12} strokeWidth={2} />
					</button>
					<button
						type="button"
						title="Open existing project…"
						data-testid="project-open"
						onClick={() => void pickProject()}
						className="rounded p-1 text-neutral-600 hover:bg-neutral-900 hover:text-neutral-300"
					>
						<FolderOpen size={12} strokeWidth={2} />
					</button>
				</div>
			</div>

			{/* Groups */}
			<div className="flex-1 overflow-y-auto px-1.5 pb-2">
				{mergedGroups.length === 0 ? (
					<p className="px-2 py-4 text-xs text-neutral-600">No sessions yet.</p>
				) : (
					mergedGroups.map((g) => {
						const project = g.key;
						const list = g.list;
						const isCollapsed = collapsedGroups.has(project);
						return (
							<div key={project} className="mb-2">
								<ProjectRow
									name={g.name}
									count={list.length}
									pinned={g.pinned}
									collapsed={isCollapsed}
									projectId={g.projectId}
									onToggle={() =>
										setCollapsedGroups((prev) => {
											const next = new Set(prev);
											if (next.has(project)) next.delete(project);
											else next.add(project);
											return next;
										})
									}
									onNewSession={() => {
										if (project === "(unknown)") return; // needs a real folder
										void createInProject(project);
									}}
									onTogglePin={() => togglePin(project)}
								/>
								{list.length === 0 && !isCollapsed && (
									<p className="px-6 py-1 text-[10px] italic text-neutral-600">
										No sessions yet — press +
									</p>
								)}
								<AnimatePresence initial={false}>
									{!isCollapsed && (
										<motion.div
											initial={{ height: 0, opacity: 0 }}
											animate={{ height: "auto", opacity: 1 }}
											exit={{ height: 0, opacity: 0 }}
											transition={{ duration: 0.18, ease: [0.2, 0, 0, 1] }}
											className="overflow-hidden"
										>
											{list.map((s) => {
												const dot = statusDot(s.id);
												const isActive =
													useSessions.getState().activeId === s.id ||
													Object.keys(liveSessions).includes(s.id);
												return (
													<div
														key={s.id}
														role="button"
														tabIndex={0}
														data-testid={`sidebar-session-${s.id}`}
														onClick={() => void openSession(s)}
														onKeyDown={(e) => {
															if (e.key === "Enter") void openSession(s);
															if (e.key === "ContextMenu") setMenuFor(s.id);
														}}
														onContextMenu={(e) => {
															e.preventDefault();
															setMenuFor(menuFor === s.id ? null : s.id);
														}}
														className={`group mx-1 cursor-pointer rounded px-2 py-1.5 ${
															isActive ? "bg-neutral-800/80" : "hover:bg-neutral-900"
														}`}
													>
														<div className="flex items-center gap-1.5">
															<span
																className={`h-1.5 w-1.5 shrink-0 rounded-full ${
																	dot === "dead"
																		? "bg-red-500"
																		: dot === "streaming"
																			? "bg-blue-500 animate-pulse"
																			: dot === "idle"
																				? "bg-green-600"
																				: "bg-transparent"
																}`}
															/>
															<span className="min-w-0 flex-1 truncate text-xs text-neutral-300">
																{s.name ?? s.firstMessage ?? s.filePath.split("/").pop()}
															</span>
															<span className="shrink-0 font-mono text-[9px] text-neutral-600">
																{relTime(s.updatedAt)}
															</span>
														</div>
														{s.costUsd > 0 && (
															<div className="ml-3 font-mono text-[9px] text-neutral-700">
																${s.costUsd.toFixed(4)}
															</div>
														)}
													</div>
												);
											})}
										</motion.div>
									)}
								</AnimatePresence>
							</div>
						);
					})
				)}
			</div>

			{/* Context menu */}
			{menuFor !== null &&
				(() => {
					const target = sessions.find((s) => s.id === menuFor);
					if (target === undefined) return null;
					return (
						<div className="absolute bottom-16 left-3 right-3 rounded-lg border border-neutral-700 bg-neutral-900 p-1 shadow-xl">
							<button
								type="button"
								onClick={() => {
									void window.piDesktop.invoke({
										type: "workspace.reveal",
										path: target.filePath,
									});
									setMenuFor(null);
								}}
								className="block w-full rounded px-3 py-1.5 text-left text-xs hover:bg-neutral-800"
							>
								Reveal file
							</button>
							<button
								type="button"
								onClick={() => {
									setConfirmDelete(target.filePath);
									setMenuFor(null);
								}}
								className="block w-full rounded px-3 py-1.5 text-left text-xs text-red-400 hover:bg-red-950"
							>
								Delete session…
							</button>
						</div>
					);
				})()}

			{confirmDelete !== null && (
				<div className="absolute inset-0 z-50 flex items-center justify-center bg-black/70 p-3">
					<div className="w-full rounded-lg border border-neutral-700 bg-neutral-900 p-3">
						<p className="mb-1 text-xs font-medium text-neutral-100">Delete session?</p>
						<p className="mb-3 text-[10px] break-all text-neutral-500">
							{confirmDelete.split("/").pop()}
						</p>
						<p className="mb-3 text-[10px] text-neutral-400">
							Moves the session file to the Trash. This cannot be undone from Pi Desktop.
						</p>
						<div className="flex justify-end gap-2">
							<button
								type="button"
								onClick={() => setConfirmDelete(null)}
								className="rounded bg-neutral-800 px-2.5 py-1 text-[10px] hover:bg-neutral-700"
							>
								Cancel
							</button>
							<button
								type="button"
								data-testid="confirm-delete-session"
								onClick={() => {
									void window.piDesktop
										.invoke({ type: "session.delete_file", sessionPath: confirmDelete })
										.then(() => {
											setConfirmDelete(null);
											void load();
										});
								}}
								className="rounded bg-red-800 px-2.5 py-1 text-[10px] text-white hover:bg-red-700"
							>
								Delete
							</button>
						</div>
					</div>
				</div>
			)}

			{/* Footer: grouped profile card. Clicking the profile opens the
			    option menu (Models / Settings / Trust / History); the gear is a
			    direct shortcut to Settings. */}
			<div className="relative border-t border-neutral-800 p-1.5">
				<button
					type="button"
					data-testid="sidebar-profile"
					title="Account & options"
					aria-haspopup="menu"
					aria-expanded={profileMenuOpen}
					onClick={() => setProfileMenuOpen((v) => !v)}
					className={`flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left hover:bg-neutral-900 ${
						profileMenuOpen ? "bg-neutral-900" : ""
					}`}
				>
					<button
						type="button"
						title="Hide sidebar (⌘\)"
						data-testid="sidebar-collapse"
						onClick={(e) => {
							e.stopPropagation();
							onToggleCollapse();
						}}
						className="-ml-1 shrink-0 rounded p-0.5 text-neutral-600 hover:bg-neutral-800 hover:text-neutral-200"
					>
						<PanelLeftClose size={13} strokeWidth={2} />
					</button>
					<span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-blue-950 text-[10px] font-medium text-blue-400">
						{initialsOf(userName)}
					</span>
					<span className="min-w-0 flex-1 truncate text-xs text-neutral-400">
						{userName.length > 0 ? userName : "—"}
					</span>
					<span
						className={`text-neutral-600 transition-transform ${profileMenuOpen ? "rotate-180" : ""}`}
					>
						<ChevronUp size={12} strokeWidth={2} />
					</span>
				</button>

				{/* No AnimatePresence here on purpose: a pending exit animation leaves
				    an invisible, pointer-events-auto ghost over the sidebar if the
				    app state changes mid-transition. Immediate unmount cannot stick. */}
				{profileMenuOpen && (
					<motion.div
						initial={{ opacity: 0, y: 6 }}
						animate={{ opacity: 1, y: 0 }}
						transition={{ duration: 0.12 }}
						role="menu"
						data-testid="sidebar-profile-menu"
						className="absolute bottom-full left-1.5 right-1.5 z-50 mb-2 overflow-hidden rounded-lg border border-neutral-800 bg-neutral-900 shadow-xl shadow-black/50"
					>
							{(
							[
								["models", "Models", "sidebar-models"],
								["settings", "Settings", "sidebar-settings"],
								["trust", "Trust", "sidebar-trust"],
								["browse", "History", "sidebar-history"],
							] as const
						).map(([kind, label, testid]) => (
							<button
								key={kind}
								type="button"
								role="menuitem"
								data-testid={testid}
								onClick={() => {
									setProfileMenuOpen(false);
									onOpenSheet(kind);
								}}
								className="block w-full px-3 py-2 text-left text-xs text-neutral-300 hover:bg-neutral-800"
							>
								{label}
							</button>
						))}
					</motion.div>
				)}
			</div>
		</div>
	);
}
