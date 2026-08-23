/**
 * Workspace dock for the chat view: file explorer, review queue, commands.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import Ansi from "ansi-to-react";
import { Markdown } from "../chat/Markdown";
import { parseArgumentHintFromHint } from "../../lib/command-hints";

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
	onOpenInEditor,
}: {
	entry: FsEntry;
	full: string;
	depth: number;
	expanded: boolean;
	onToggle(): void;
	onOpenInEditor?(path: string): void;
}): React.JSX.Element {
	return (
		<div
			className={`group flex items-center hover:bg-neutral-800/60 ${
				entry.type === "dir" ? "" : "text-neutral-400"
			}`}
			style={{ paddingLeft: `${depth * 12 + 12}px` }}
		>
			<button
				type="button"
				onClick={onToggle}
				className={`min-w-0 flex-1 truncate py-0.5 pr-2 text-left text-xs ${
					entry.type === "dir" ? "text-neutral-300" : "text-neutral-400"
				}`}
				title={full}
			>
				{entry.type === "dir" ? (expanded ? "▾ " : "▸ ") : ""}
				{entry.name}
			</button>
			{entry.type === "file" && onOpenInEditor !== undefined && (
				<button
					type="button"
					title="Open in editor"
					onClick={() => onOpenInEditor(full)}
					className="mr-2 hidden shrink-0 rounded px-1 text-[10px] text-neutral-600 hover:text-neutral-200 group-hover:block"
				>
					↗
				</button>
			)}
		</div>
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

	function openInEditor(path: string): void {
		void window.piDesktop
			.invoke({ type: "workspace.open_in_editor", path })
			.then((r) => {
				if (!r.ok) setError(r.error.message);
			});
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
							onOpenInEditor={openInEditor}
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
							onOpenInEditor={openInEditor}
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
// Session tree visualizer + navigation
// ---------------------------------------------------------------------------

interface TreeNode {
	entry: {
		id: string;
		type?: string;
		timestamp?: string | number;
		message?: { role?: string; content?: unknown };
	};
	children: TreeNode[];
	label?: string;
}

function nodePreview(node: TreeNode): string {
	if (node.label !== undefined) return node.label;
	const msg = node.entry.message;
	if (msg === undefined) {
		const type = node.entry.type ?? "entry";
		return type === "compaction" ? "[compaction]" : `[${type}]`;
	}
	const text = extractTextContent(msg.content);
	return text.slice(0, 80) || `[${String(msg.role ?? "message")}]`;
}

function extractTextContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.filter((c): c is { type: string; text?: string } =>
				typeof c === "object" && c !== null && (c as { type?: string }).type === "text"
			)
			.map((c) => c.text ?? "")
			.join(" ");
	}
	return "";
}

export function SessionTreePanel({
	sessionId,
	onNavigate,
	onFork,
	refreshKey,
}: {
	sessionId: string;
	onNavigate(entryId: string, summarize: boolean, instructions: string): void;
	onFork(entryId: string): void;
	refreshKey: number;
}): React.JSX.Element {
	const [tree, setTree] = useState<TreeNode[] | null>(null);
	const [selected, setSelected] = useState<string | null>(null);
	const [summarize, setSummarize] = useState(false);
	const [instructions, setInstructions] = useState("");
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		setTree(null);
		void window.piDesktop
			.invoke({ type: "session.tree", sessionId })
			.then((r) => {
				if (r.ok) setTree(r.data as unknown as TreeNode[]);
				else setError(r.error.message);
			})
			.catch((e: Error) => setError(e.message));
	}, [sessionId, refreshKey]);

	function renderNodes(nodes: TreeNode[], depth: number): ReactNode[] {
		const out: ReactNode[] = [];
		for (const node of nodes) {
			const isSelected = selected === node.entry.id;
			out.push(
				<button
					key={node.entry.id}
					type="button"
					onClick={() => setSelected(node.entry.id)}
					className={`block w-full truncate rounded px-2 py-0.5 text-left text-[11px] hover:bg-neutral-800/60 ${
						isSelected ? "bg-blue-950/60 text-blue-200" : "text-neutral-300"
					}`}
					style={{ paddingLeft: `${depth * 12 + 8}px` }}
					title={node.entry.id}
				>
					{node.children.length > 0 ? "⑂ " : "· "}
					{nodePreview(node)}
				</button>
			);
			out.push(...renderNodes(node.children, depth + 1));
		}
		return out;
	}

	return (
		<div className="flex h-full flex-col">
			{error !== null && <div className="px-3 py-2 text-[10px] text-red-400">{error}</div>}
			<div className="flex-1 overflow-y-auto p-2">
				{tree === null ? (
					<p className="p-2 text-xs text-neutral-600">Loading tree…</p>
				) : (
					renderNodes(tree, 0)
				)}
			</div>
			{selected !== null && (
				<div className="border-t border-neutral-800 p-2.5">
					<div className="mb-1.5 font-mono text-[9px] text-neutral-600">{selected}</div>
					<label className="flex items-center gap-1.5 text-[10px] text-neutral-400">
						<input
							type="checkbox"
							checked={summarize}
							onChange={(e) => setSummarize(e.target.checked)}
						/>
						Summarize abandoned branch
					</label>
					{summarize && (
						<input
							value={instructions}
							onChange={(e) => setInstructions(e.target.value)}
							placeholder="Summary instructions (optional)"
							className="mt-1.5 w-full rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-[11px] outline-none focus:border-blue-500"
						/>
					)}
					<div className="mt-2 flex gap-1.5">
						<button
							type="button"
							onClick={() => {
								onNavigate(selected, summarize, instructions);
								setSelected(null);
								setInstructions("");
							}}
							className="rounded bg-blue-700 px-2.5 py-1 text-[10px] text-white hover:bg-blue-600"
						>
							Navigate here
						</button>
						<button
							type="button"
							onClick={() => {
								onFork(selected);
								setSelected(null);
							}}
							className="rounded bg-neutral-800 px-2.5 py-1 text-[10px] text-neutral-300 hover:bg-neutral-700"
						>
							Fork from here
						</button>
					</div>
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

interface DetailedCommand extends CommandInfo {
	path?: string;
	argumentHint?: string;
}

function parseArgumentHint(text: string): string[] | null {
	const match = /argument-hint:\s*"([^"]+)"/.exec(text);
	if (match === null || match[1] === undefined) return null;
	const hints: string[] = [];
	for (const m of match[1].matchAll(/[<\[]([^>\]]+)[>\]]/g)) {
		const name = m[1];
		if (name !== undefined) hints.push(name);
	}
	return hints.length > 0 ? hints : null;
}

function splitFrontmatter(text: string): { body: string; head: string } {
	const m = /^---\n([\s\S]*?)\n---\n?/.exec(text);
	if (m === null || m[1] === undefined) return { body: text, head: "" };
	return { head: m[1], body: text.slice(m[0].length) };
}

export function CommandsBrowser({
	sessionId,
	onInsert,
}: {
	sessionId: string;
	onInsert(text: string): void;
}): React.JSX.Element {
	const [commands, setCommands] = useState<DetailedCommand[]>([]);
	const [filter, setFilter] = useState("");
	const [detail, setDetail] = useState<{ command: DetailedCommand; content: string } | null>(null);
	const [argValues, setArgValues] = useState<string[]>([]);
	const [argHints, setArgHints] = useState<string[] | null>(null);

	useEffect(() => {
		void window.piDesktop
			.invoke({ type: "session.commands", sessionId })
			.then((r) => {
				if (r.ok) setCommands(r.data.commands as DetailedCommand[]);
			})
			.catch(() => {});
	}, [sessionId]);

	function openArgForm(command: DetailedCommand, hints: string[] | null, content: string): void {
		setDetail({ command, content });
		setArgHints(hints);
		setArgValues([]);
	}

	function inspect(command: DetailedCommand): void {
		// Upstream hands us the hint directly for prompt templates — no need to
		// fetch and re-parse the frontmatter we already have.
		if (command.argumentHint !== undefined) {
			const hints = parseArgumentHintFromHint(command.argumentHint);
			openArgForm(command, hints.length > 0 ? hints : null, command.description ?? "");
			return;
		}
		if (command.path === undefined) {
			onInsert(`/${command.name} `);
			return;
		}
		void window.piDesktop
			.invoke({ type: "resources.read_text", path: command.path })
			.then((r) => {
				// A denied or unreadable source used to leave the user staring at
				// nothing; fall back to the plain insert instead.
				if (!r.ok) {
					onInsert(`/${command.name} `);
					return;
				}
				const { body, head } = splitFrontmatter(r.data.content);
				openArgForm(command, parseArgumentHint(head), body);
			})
			.catch(() => onInsert(`/${command.name} `));
	}

	function insertWithArgs(): void {
		if (detail === null) return;
		const args =
			argHints !== null
				? " " + argHints.map((hint, i) => argValues[i] ?? `<${hint}>`).join(" ")
				: "";
		onInsert(`/${detail.command.name}${args}`);
		setDetail(null);
	}

	const filtered = commands.filter((c) =>
		`${c.name} ${c.description ?? ""}`.toLowerCase().includes(filter.toLowerCase())
	);
	const groups = new Map<string, DetailedCommand[]>();
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
				{detail !== null ? (
					<div>
						<button
							type="button"
							onClick={() => setDetail(null)}
							className="mb-2 rounded bg-neutral-800 px-2 py-0.5 text-[10px] text-neutral-400 hover:bg-neutral-700"
						>
							← back
						</button>
						<h4 className="font-mono text-xs text-neutral-200">
							/{detail.command.name}
						</h4>
						{argHints !== null && (
							<div className="mt-2 flex flex-col gap-1.5">
								{argHints.map((hint, i) => (
									<input
										key={hint}
										value={argValues[i] ?? ""}
										onChange={(e) => {
											const next = [...argValues];
											next[i] = e.target.value;
											setArgValues(next);
										}}
										placeholder={hint}
										className="rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-[11px] outline-none focus:border-blue-500"
									/>
								))}
							</div>
						)}
						<div className="my-2 max-h-64 overflow-y-auto rounded bg-neutral-950 p-2 text-[11px] text-neutral-300 [&_p]:mb-1.5">
							<Markdown text={detail.content.slice(0, 8_000)} />
						</div>
						<button
							type="button"
							onClick={insertWithArgs}
							className="w-full rounded bg-blue-700 px-3 py-1.5 text-xs text-white hover:bg-blue-600"
						>
							Insert /{detail.command.name}
						</button>
					</div>
				) : filtered.length === 0 ? (
					<p className="p-2 text-xs text-neutral-600">No commands available.</p>
				) : (
					[...groups.entries()].map(([source, list]) => (
						<div key={source} className="mb-3">
							<div className="mb-1 px-2 text-[10px] tracking-wide text-neutral-500 uppercase">
								{source}
							</div>
							{list.map((c) => (
								<button
									key={c.name + (c.path ?? "")}
									type="button"
									onClick={() => inspect(c)}
									title={c.path ?? `Insert /${c.name}`}
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
