/**
 * Composer v2 (chapter 16): borderless command surface with inline model chip,
 * "/" palette, steer/follow-up segmented toggle, attach row, git-strip slot.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { PiImageInput, PiModelInfo, PiThinkingLevel } from "../../../../shared/pi";
import { ModelPicker } from "./ModelPicker";
import { ThinkingPicker } from "./ThinkingPicker";

interface Attachment {
	id: string;
	name: string;
	size: number;
	kind: "image" | "text" | "path-ref";
	/** Absolute path, when Electron can resolve it (drag-drop / paste). */
	fullPath?: string;
	imageData?: string;
	mimeType?: string;
	textContent?: string;
}

export function Composer({
	streaming,
	queueCount,
	insertText,
	onInsertHandled,
	onSend,
	onBash,
	onAbort,
	onOpenPalette,
	onOpenReview,
	projectRoot,
	modelName,
	models,
	currentModel,
	onPickModel,
	thinkingLevel,
	supportedThinkingLevels,
	onPickThinkingLevel,
}: {
	streaming: boolean;
	queueCount: number;
	insertText?: string | null;
	onInsertHandled?(): void;
	onSend(text: string, images: PiImageInput[], streamingBehavior?: "steer" | "followUp"): void;
	onBash(command: string, excludeFromContext: boolean): void;
	onAbort(): void;
	onOpenPalette(): void;
	onOpenReview(): void;
	projectRoot: string | null;
	modelName?: string | undefined;
	/** Full catalog for the searchable picker; omit to render a passive chip. */
	models?: PiModelInfo[] | undefined;
	currentModel?: { provider: string; id: string; name: string } | undefined;
	onPickModel?(model: PiModelInfo): void;
	/** Reasoning-effort selector; omit to hide the control entirely. */
	thinkingLevel?: PiThinkingLevel | undefined;
	supportedThinkingLevels?: PiThinkingLevel[] | undefined;
	onPickThinkingLevel?(level: PiThinkingLevel): void;
}): React.JSX.Element {
	const [text, setText] = useState("");
	const [attachments, setAttachments] = useState<Attachment[]>([]);
	const [followUpMode, setFollowUpMode] = useState(false);
	const [dragging, setDragging] = useState(false);
	const [git, setGit] = useState<{
		repo: boolean;
		branch: string | null;
		staged: number;
		unstaged: number;
		ahead: number;
		behind: number;
	} | null>(null);
	const inputRef = useRef<HTMLTextAreaElement>(null);

	const autoGrow = useCallback((): void => {
		const el = inputRef.current;
		if (el === null) return;
		el.style.height = "auto";
		el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
	}, []);

	// Git context strip data (chapter 16).
	useEffect(() => {
		if (projectRoot === null) {
			setGit(null);
			return;
		}
		let cancelled = false;
		void window.piDesktop
			.invoke({ type: "git.context", root: projectRoot })
			.then((r) => {
				if (!cancelled && r.ok) setGit(r.data as never);
			})
			.catch(() => {});
		const timer = setInterval(() => {
			void window.piDesktop
				.invoke({ type: "git.context", root: projectRoot })
				.then((r) => {
					if (!cancelled && r.ok) setGit(r.data as never);
				})
				.catch(() => {});
		}, 10_000);
		return () => {
			cancelled = true;
			clearInterval(timer);
		};
	}, [projectRoot]);

	useEffect(() => {
		autoGrow();
	}, [text, autoGrow]);

	useEffect(() => {
		if (insertText !== undefined && insertText !== null && insertText.length > 0) {
			setText(
				(prev) =>
					prev.endsWith(" ") || prev.length === 0 ? prev + insertText : `${prev} ${insertText}`
			);
			onInsertHandled?.();
			inputRef.current?.focus();
		}
	}, [insertText, onInsertHandled]);

	const TEXT_EXTENSIONS = new Set(["ts","js","py","md","json","txt","css","html","yaml","yml","toml","sh","rs","go","java","rb","sql","xml","csv"]);

	async function fileToAttachment(file: File): Promise<Attachment> {
		const id = `att-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
		if (file.type.startsWith("image/")) {
			const buffer = await file.arrayBuffer();
			let binary = "";
			const bytes = new Uint8Array(buffer);
			for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i] ?? 0);
			return { id, name: file.name, size: file.size, kind: "image", imageData: btoa(binary), mimeType: file.type };
		}
		const ext = file.name.split(".").pop() ?? "";
		if (TEXT_EXTENSIONS.has(ext) && file.size <= 100_000) {
			const textContent = await file.text();
			return { id, name: file.name, size: file.size, kind: "text", textContent };
		}
		// Large or unknown type → path reference. A bare filename is useless to the
		// agent, so resolve the real path through the preload bridge.
		const fullPath = window.piDesktop.filePath(file);
		return {
			id,
			name: file.name,
			size: file.size,
			kind: "path-ref",
			...(fullPath.length > 0 ? { fullPath } : {}),
		};
	}

	async function filesToAttachments(files: FileList): Promise<Attachment[]> {
		const out: Attachment[] = [];
		for (const file of Array.from(files)) {
			out.push(await fileToAttachment(file));
		}
		return out;
	}

	function submit(): void {
		const trimmed = text.trim();
		if (trimmed.length === 0 && attachments.length === 0) return;
		if (trimmed.startsWith("!!")) {
			onBash(trimmed.slice(2).trim(), true);
			setText("");
			return;
		}
		if (trimmed.startsWith("!")) {
			onBash(trimmed.slice(1).trim(), false);
			setText("");
			return;
		}
		// Convert attachments to images + inline text for pi
		const imgs: PiImageInput[] = [];
		let extraContext = "";
		for (const att of attachments) {
			if (att.kind === "image" && att.imageData && att.mimeType) {
				imgs.push({ data: att.imageData, mimeType: att.mimeType });
			} else if (att.kind === "text" && att.textContent) {
				extraContext += `\n\nFile: ${att.name}\n\`\`\`\n${att.textContent.slice(0, 10_000)}\n\`\`\``;
			} else if (att.kind === "path-ref") {
				extraContext += `\n\nSee file: ${att.fullPath ?? att.name}`;
			}
		}
		const fullText = extraContext.length > 0 ? trimmed + "\n" + extraContext : trimmed;
		const behavior = streaming ? (followUpMode ? "followUp" : "steer") : undefined;
		onSend(fullText, imgs, behavior);
		setText("");
		setAttachments([]);
	}

	return (
		<div
			className="relative px-3 pb-3"
			onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
			onDragLeave={(e) => { if (e.currentTarget === e.target) setDragging(false); }}
			onDrop={(e) => {
				e.preventDefault();
				setDragging(false);
				if (e.dataTransfer.files.length > 0) {
					void filesToAttachments(e.dataTransfer.files).then((atts) =>
						setAttachments((prev) => [...prev, ...atts])
					);
				}
			}}
		>
			{dragging && (
				<div className="absolute inset-0 z-10 flex items-center justify-center rounded-lg border-2 border-dashed border-blue-500 bg-blue-950/30 text-sm text-blue-300">
					Drop files here…
				</div>
			)}
			{/* Git context strip */}
			{git !== null && git.repo && (
				<div
					className="mb-1.5 flex items-center gap-2 rounded-t-lg border border-b-0 border-neutral-800 bg-neutral-900/60 px-4 py-1.5 font-mono text-[10px] text-neutral-400"
					data-testid="git-strip"
				>
					<span>⎇ {git.branch ?? "no branch"}</span>
					{(git.staged > 0 || git.unstaged > 0) && (
						<span>
							{git.staged > 0 && <span className="text-green-500">+{git.staged} </span>}
							{git.unstaged > 0 && <span className="text-red-400">−{git.unstaged}</span>}
						</span>
					)}
					{git.ahead > 0 && <span className="text-neutral-500">↑{git.ahead}</span>}
					{git.behind > 0 && <span className="text-neutral-500">↓{git.behind}</span>}
					<button
						type="button"
						onClick={onOpenReview}
						className="ml-auto rounded bg-neutral-800 px-1.5 py-0.5 text-[9px] text-neutral-300 hover:bg-neutral-700"
					>
						Open review
					</button>
				</div>
			)}

			<div className="rounded-xl border border-neutral-700/80 bg-neutral-900/80 transition-colors focus-within:border-blue-600/70">
				<textarea
					ref={inputRef}
					value={text}
					rows={1}
					onChange={(e) => {
						setText(e.target.value);
						autoGrow();
						if (e.target.value === "/") onOpenPalette();
					}}
					onKeyDown={(e) => {
						if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
							e.preventDefault();
							submit();
						}
					}}
					onPaste={(e) => {
						const files = e.clipboardData.files;
						if (files.length > 0) {
							e.preventDefault();
							void filesToAttachments(files).then((atts) =>
								setAttachments((prev) => [...prev, ...atts])
							);
						}
					}}
					placeholder={
						streaming
							? followUpMode
								? "Queue as follow-up…"
								: "Steer the agent…"
							: "Type / for commands — describe a task…"
					}
					data-testid="composer-input"
					className="max-h-[200px] w-full resize-none bg-transparent px-4 pt-3 text-sm outline-none placeholder:text-neutral-600"
				/>

				{attachments.length > 0 && (
					<div className="flex flex-wrap gap-1.5 px-4 pb-1">
						{attachments.map((att) => (
							<span
								key={att.id}
								className="group relative inline-flex items-center gap-1 rounded-md border border-neutral-700 bg-neutral-800 px-2 py-1"
							>
								{att.kind === "image" && att.imageData && (
									<img src={`data:${att.mimeType};base64,${att.imageData}`} alt={att.name} className="h-8 w-8 rounded object-cover" />
								)}
								{att.kind !== "image" && <span className="text-[10px]">📄</span>}
								<span className="max-w-[140px] truncate text-[10px] text-neutral-300">{att.name}</span>
								<button
									type="button"
									onClick={() => setAttachments((prev) => prev.filter((a) => a.id !== att.id))}
									className="ml-0.5 text-neutral-500 hover:text-red-400"
									title="Remove attachment"
								>
									×
								</button>
							</span>
						))}
					</div>
				)}

				{/* Bottom control row */}
				<div className="flex items-center gap-2 px-3 pb-2.5 pt-1">
					{streaming ? (
						<>
							<div className="flex overflow-hidden rounded-md border border-neutral-700">
								<button
									type="button"
									onClick={() => setFollowUpMode(false)}
									className={`px-2 py-1 text-[10px] ${
										!followUpMode ? "bg-blue-950 text-blue-300" : "bg-neutral-900 text-neutral-500"
									}`}
								>
									Steer
								</button>
								<button
									type="button"
									onClick={() => setFollowUpMode(true)}
									className={`px-2 py-1 text-[10px] ${
										followUpMode ? "bg-purple-950 text-purple-300" : "bg-neutral-900 text-neutral-500"
									}`}
								>
									Follow-up
								</button>
							</div>
							{queueCount > 0 && (
								<span className="text-[10px] text-amber-500">{queueCount} queued</span>
							)}
							<button
								type="button"
								onClick={onAbort}
								data-testid="abort-button"
								className="ml-auto rounded bg-red-800 px-4 py-1.5 text-xs font-medium text-white hover:bg-red-700"
							>
								Stop
							</button>
						</>
					) : (
						<>
							{modelName !== undefined && (
								<ModelPicker
									models={models ?? []}
									current={currentModel}
									onPick={(m) => onPickModel?.(m)}
								/>
							)}
							{onPickThinkingLevel !== undefined && (
								<ThinkingPicker
									level={thinkingLevel}
									supportedLevels={supportedThinkingLevels ?? []}
									onPick={(l) => onPickThinkingLevel(l)}
								/>
							)}
							<button
								type="button"
								data-testid="send-button"
								disabled={text.trim().length === 0 && attachments.length === 0}
								onClick={submit}
								className="ml-auto flex h-7 w-7 items-center justify-center rounded-full bg-blue-600 text-white transition-all hover:bg-blue-500 active:scale-95 disabled:opacity-40"
								title="Send"
							>
								↑
							</button>
						</>
					)}
				</div>
			</div>
		</div>
	);
}
