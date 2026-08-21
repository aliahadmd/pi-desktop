/**
 * Workspace dock for the chat view: file explorer, review queue, commands.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import Ansi from "ansi-to-react";

// ---------------------------------------------------------------------------
// File explorer (read-only, scoped to session cwd)
// ---------------------------------------------------------------------------

interface FsEntry {
	name: string;
	type: "dir" | "file";
	size: number;
}

interface ListingCache {
	get(dir: string): FsEntry[] | undefined;
	set(dir: string, entries: FsEntry[]): void;
}

function makeCache(): ListingCache {
	const map = new Map<string, FsEntry[]>();
	return {
		get: (dir) => map.get(dir),
		set: (dir, entries) => map.set(dir, entries),
	};
}

/** Module-scope row: stable identity across renders (no remount churn). */
function ExplorerRow({
	entry,
	full,
	depth,
	expanded,
	onToggle,
}: {
	entry: FsEntry;
	full: string;
	depth: number;
	expanded: boolean;
	onToggle(): void;
}): React.JSX.Element {
	return (
		<button
			type="button"
			onClick={onToggle}
			className={`block w-full truncate px-3 py-0.5 text-left text-xs hover:bg-neutral-800/60 ${
				entry.type === "dir" ? "text-neutral-300" : "text-neutral-400"
			}`}
			style={{ paddingLeft: `${depth * 12 + 12}px` }}
			title={full}
		>
			{entry.type === "dir" ? (expanded ? "▾ " : "▸ ") : ""}
			{entry.name}
		</button>
	);
}

export function FileExplorer({ cwd }: { cwd: string }): React.JSX.Element {
	const [listings, setListings] = useState<Map<string, FsEntry[]>>(new Map());
	const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set());
	const [fileContent, setFileContent] = useState<{ path: string; content: string } | null>(null);
	const [error, setError] = useState<string | null>(null);
	const cacheRef = useRef<ListingCache>(makeCache());

	const loadDir = useCallback(
		async (dir: string): Promise<void> => {
			const cached = cacheRef.current.get(dir);
			if (cached !== undefined) {
				setListings((prev) => new Map(prev).set(dir, cached));
				return;
			}
			const result = await window.piDesktop.invoke({ type: "fs.list", dirPath: dir });
			if (!result.ok) {
				setError(result.error.message);
				return;
			}
			setError(null);
			cacheRef.current.set(dir, result.data.entries);
			setListings((prev) => new Map(prev).set(dir, result.data.entries));
		},
		[]
	);

	useEffect(() => {
		setExpandedDirs(new Set());
		setFileContent(null);
		void loadDir(cwd);
	}, [cwd, loadDir]);

	function toggleDir(full: string): void {
		setExpandedDirs((prev) => {
			const next = new Set(prev);
			if (next.has(full)) next.delete(full);
			else {
				next.add(full);
				void loadDir(full); // fetch on expand
			}
			return next;
		});
	}

	async function openFile(full: string): Promise<void> {
		const result = await window.piDesktop.invoke({ type: "fs.read", filePath: full });
		if (result.ok) {
			setFileContent({ path: full, content: result.data.content });
		} else {
			setError(result.error.message);
		}
	}

	function renderDir(dir: string, depth: number): ReactNode[] {
		const entries = dir === cwd ? listings.get(cwd) : listings.get(dir);
		if (entries === undefined) return [];
		const out: ReactNode[] = [];
		if (dir !== cwd) {
			out.push(
				<div
					key={`d-${dir}`}
					className="px-3 py-0.5 text-xs font-medium text-neutral-400"
					style={{ paddingLeft: `${depth * 12}px` }}
				>
					{dir.split("/").pop()}
				</div>
			);
		}
		for (const entry of entries) {
			const full = `${dir}/${entry.name}`;
			if (entry.type === "dir") {
				const isOpen = expandedDirs.has(full);
				out.push(
					<ExplorerRow
						key={`e-${full}`}
						entry={entry}
						full={full}
						depth={depth}
						expanded={isOpen}
						onToggle={() => toggleDir(full)}
					/>
				);
				if (isOpen) out.push(...renderDir(full, depth + 1));
			} else {
				out.push(
					<ExplorerRow
						key={`e-${full}`}
						entry={entry}
						full={full}
						depth={depth}
						expanded={false}
						onToggle={() => void openFile(full)}
					/>
				);
			}
		}
		return out;
	}

	return (
		<div className="flex h-full flex-col">
			<div className="truncate border-b border-neutral-800 px-3 py-2 font-mono text-[10px] text-neutral-500">
				{cwd}
			</div>
			{error !== null && <div className="px-3 py-2 text-[10px] text-red-400">{error}</div>}
			<div className="flex-1 overflow-y-auto py-1">{renderDir(cwd, 0)}</div>
			{fileContent !== null && (
				<div className="h-1/2 overflow-auto border-t border-neutral-800 bg-neutral-950 p-3">
					<div className="mb-1 flex items-center justify-between">
						<span className="font-mono text-[10px] text-neutral-500">{fileContent.path}</span>
						<button
							type="button"
							onClick={() => setFileContent(null)}
							className="text-[10px] text-neutral-500 hover:text-neutral-300"
						>
							close
						</button>
					</div>
					<pre className="font-mono text-[11px] whitespace-pre-wrap text-neutral-300">
						{fileContent.content.slice(0, 50_000)}
					</pre>
				</div>
			)}
		</div>
	);
}

// ---------------------------------------------------------------------------
// Commands browser (skills / prompts / extension commands)
// ---------------------------------------------------------------------------

interface CommandInfo {
	name: string;
	description?: string;
	source: string;
}

export function CommandsBrowser({
	sessionId,
	onInsert,
}: {
	sessionId: string;
	onInsert(text: string): void;
}): React.JSX.Element {
	const [commands, setCommands] = useState<CommandInfo[]>([]);
	const [filter, setFilter] = useState("");

	useEffect(() => {
		void window.piDesktop
			.invoke({ type: "session.commands", sessionId })
			.then((r) => {
				if (r.ok) setCommands(r.data.commands);
			})
			.catch(() => {});
	}, [sessionId]);

	const filtered = commands.filter((c) =>
		`${c.name} ${c.description ?? ""}`.toLowerCase().includes(filter.toLowerCase())
	);
	const groups = new Map<string, CommandInfo[]>();
	for (const c of filtered) {
		const list = groups.get(c.source) ?? [];
		list.push(c);
		groups.set(c.source, list);
	}

	return (
		<div className="flex h-full flex-col">
			<input
				value={filter}
				onChange={(e) => setFilter(e.target.value)}
				placeholder="Filter commands…"
				className="border-b border-neutral-800 bg-transparent px-3 py-2 text-xs outline-none"
			/>
			<div className="flex-1 overflow-y-auto p-2">
				{filtered.length === 0 ? (
					<p className="p-2 text-xs text-neutral-600">No commands available.</p>
				) : (
					[...groups.entries()].map(([source, list]) => (
						<div key={source} className="mb-3">
							<div className="mb-1 px-2 text-[10px] tracking-wide text-neutral-500 uppercase">
								{source}
							</div>
							{list.map((c) => (
								<button
									key={c.name}
									type="button"
									onClick={() => onInsert(`/${c.name} `)}
									title={`Insert /${c.name}`}
									className="block w-full rounded px-2 py-1 text-left hover:bg-neutral-800/60"
								>
									<span className="font-mono text-xs text-neutral-200">/{c.name}</span>
									{c.description !== undefined && (
										<span className="ml-2 text-[10px] text-neutral-500">{c.description}</span>
									)}
								</button>
							))}
						</div>
					))
				)}
			</div>
		</div>
	);
}

// ---------------------------------------------------------------------------
// Review queue: edit/write tool calls from the transcript
// ---------------------------------------------------------------------------

import type { Block } from "../../lib/ingest";

export function ReviewQueue({ blocks }: { blocks: Block[] }): React.JSX.Element {
	const reviewable = blocks.filter(
		(b) => b.kind === "tool" && ["edit", "write"].includes(b.toolName)
	);
	if (reviewable.length === 0) {
		return (
			<p className="p-3 text-xs text-neutral-600">
				File changes made by the agent appear here with diffs.
			</p>
		);
	}
	return (
		<div className="overflow-y-auto p-2">
			{reviewable.map((b) => {
				if (b.kind !== "tool") return null;
				const isDiff = b.output.startsWith("diff --git") || b.output.includes("\n@@ ");
				return (
					<div key={b.id} className="mb-2 rounded border border-neutral-800">
						<div className="flex items-center gap-2 border-b border-neutral-800 px-2 py-1.5">
							<span
								className={`text-[10px] ${b.status === "error" ? "text-red-400" : "text-green-500"}`}
							>
								{b.status === "error" ? "✗" : "✓"}
							</span>
							<span className="text-xs text-neutral-300">{b.toolName}</span>
							{b.argsJson !== undefined && (
								<span className="truncate font-mono text-[9px] text-neutral-600">
									{b.argsJson.slice(0, 80)}
								</span>
							)}
							<button
								type="button"
								onClick={() => void navigator.clipboard.writeText(b.output)}
								className="ml-auto rounded bg-neutral-800 px-1.5 py-0.5 text-[9px] text-neutral-400 hover:bg-neutral-700"
							>
								Copy patch
							</button>
						</div>
						<pre className="max-h-40 overflow-auto p-2 font-mono text-[10px] whitespace-pre-wrap text-neutral-300">
							{isDiff ? b.output : <Ansi>{b.output.slice(0, 5_000)}</Ansi>}
						</pre>
					</div>
				);
			})}
		</div>
	);
}
