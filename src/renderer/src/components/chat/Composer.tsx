/**
 * Composer: auto-growing input, Enter=send (steer/followUp while streaming),
 * Shift+Enter newline, Esc abort, image paste.
 */
import { useEffect, useRef, useState } from "react";
import type { PiImageInput } from "../../../../shared/pi";

export function Composer({
	streaming,
	queueCount,
	insertText,
	onInsertHandled,
	onSend,
	onAbort,
}: {
	streaming: boolean;
	queueCount: number;
	insertText?: string | null;
	onInsertHandled?(): void;
	onSend(text: string, images: PiImageInput[], streamingBehavior?: "steer" | "followUp"): void;
	onAbort(): void;
}): React.JSX.Element {
	const [text, setText] = useState("");
	const [images, setImages] = useState<PiImageInput[]>([]);
	const [followUpMode, setFollowUpMode] = useState(false);
	const inputRef = useRef<HTMLTextAreaElement>(null);

	useEffect(() => {
		if (insertText !== undefined && insertText !== null && insertText.length > 0) {
			setText((prev) => (prev.endsWith(" ") || prev.length === 0 ? prev + insertText : `${prev} ${insertText}`));
			onInsertHandled?.();
			inputRef.current?.focus();
		}
	}, [insertText, onInsertHandled]);

	function autoGrow(): void {
		const el = inputRef.current;
		if (el === null) return;
		el.style.height = "auto";
		el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
	}

	async function filesToImages(files: FileList): Promise<PiImageInput[]> {
		const out: PiImageInput[] = [];
		for (const file of Array.from(files)) {
			if (!file.type.startsWith("image/")) continue;
			const buffer = await file.arrayBuffer();
			let binary = "";
			const bytes = new Uint8Array(buffer);
			for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i] ?? 0);
			out.push({ data: btoa(binary), mimeType: file.type });
		}
		return out;
	}

	function submit(): void {
		const trimmed = text.trim();
		if (trimmed.length === 0 && images.length === 0) return;
		const behavior = streaming ? (followUpMode ? "followUp" : "steer") : undefined;
		onSend(trimmed, images, behavior);
		setText("");
		setImages([]);
		requestAnimationFrame(autoGrow);
	}

	return (
		<div className="border-t border-neutral-800 p-3">
			{queueCount > 0 && (
				<div className="mb-1.5 text-[10px] text-amber-500">
					{queueCount} message{queueCount > 1 ? "s" : ""} queued
				</div>
			)}
			{images.length > 0 && (
				<div className="mb-1.5 flex gap-2">
					{images.map((img, i) => (
						<button
							key={i}
							type="button"
							onClick={() => setImages((prev) => prev.filter((_, j) => j !== i))}
							className="rounded bg-neutral-800 px-2 py-0.5 text-[10px] text-neutral-400 hover:bg-red-950 hover:text-red-300"
							title="Remove"
						>
							image {i + 1} ({img.mimeType}) ×
						</button>
					))}
				</div>
			)}
			<div className="flex items-end gap-2">
				<textarea
					ref={inputRef}
					value={text}
					rows={1}
					onChange={(e) => {
						setText(e.target.value);
						autoGrow();
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
							void filesToImages(files).then((imgs) =>
								setImages((prev) => [...prev, ...imgs])
							);
						}
					}}
					placeholder={
						streaming
							? followUpMode
								? "Queue as follow-up…"
								: "Steer the agent…"
							: "Prompt pi… (Enter to send, Shift+Enter for newline)"
					}
					data-testid="composer-input"
					className="max-h-[200px] flex-1 resize-none rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-2.5 text-sm outline-none focus:border-blue-500"
				/>
				{streaming ? (
					<>
						<button
							type="button"
							onClick={() => setFollowUpMode((v) => !v)}
							className={`rounded px-2 py-2 text-[10px] ${
								followUpMode ? "bg-purple-800 text-white" : "bg-neutral-800 text-neutral-400"
							}`}
							title="Toggle steer / follow-up queueing"
						>
							{followUpMode ? "FOLLOW-UP" : "STEER"}
						</button>
						<button
							type="button"
							onClick={onAbort}
							data-testid="abort-button"
							className="rounded bg-red-800 px-3 py-2.5 text-xs font-medium text-white hover:bg-red-700"
						>
							Stop
						</button>
					</>
				) : (
					<button
						type="button"
						onClick={submit}
						data-testid="send-button"
						disabled={text.trim().length === 0 && images.length === 0}
						className="rounded bg-blue-600 px-4 py-2.5 text-xs font-medium text-white hover:bg-blue-500 disabled:opacity-40"
					>
						Send
					</button>
				)}
			</div>
		</div>
	);
}
