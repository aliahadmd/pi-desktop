/**
 * ModelPicker: searchable command-palette-style model selector.
 *
 * Best practice for 50+ model catalogs (VS Code, Claude Desktop, ChatGPT):
 * a button that opens an upward popover with a search input that is
 * auto-focused, full keyboard support (↑↓ move, Enter select, Esc close),
 * grouped by provider with the active model marked and pre-filtered to it.
 * The list scrolls its own overflow; the popover never grows past ~40vh.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronUp, Search } from "lucide-react";
import type { PiModelInfo } from "../../../../shared/pi";

export function ModelPicker({
	models,
	current,
	onPick,
}: {
	models: PiModelInfo[];
	current?: { provider: string; id: string; name: string } | undefined;
	onPick(model: PiModelInfo): void;
}): React.JSX.Element {
	const [open, setOpen] = useState(false);
	const [query, setQuery] = useState("");
	const [cursor, setCursor] = useState(0);
	const inputRef = useRef<HTMLInputElement>(null);
	const listRef = useRef<HTMLDivElement>(null);

	const filtered = useMemo(() => {
		const q = query.trim().toLowerCase();
		const match = (m: PiModelInfo): boolean =>
			q.length === 0 ||
			m.name.toLowerCase().includes(q) ||
			m.id.toLowerCase().includes(q) ||
			m.provider.toLowerCase().includes(q);
		return models.filter(match);
	}, [models, query]);

	// Group by provider, preserving catalog order.
	const groups = useMemo(() => {
		const map = new Map<string, PiModelInfo[]>();
		for (const m of filtered) {
			const list = map.get(m.provider) ?? [];
			list.push(m);
			map.set(m.provider, list);
		}
		return [...map.entries()];
	}, [filtered]);

	// Flat order must mirror what is rendered so ↑↓/Enter line up.
	const flat = useMemo(() => groups.flatMap(([, ms]) => ms), [groups]);

	useEffect(() => {
		if (!open) {
			setQuery("");
			setCursor(0);
			return;
		}
		// Focus the search box after the pop animation starts.
		const t = setTimeout(() => inputRef.current?.focus(), 20);
		return () => clearTimeout(t);
	}, [open]);

	// Keep the highlighted row in view while arrowing.
	useEffect(() => {
		if (!open) return;
		const el = listRef.current?.querySelector<HTMLElement>(
			`[data-idx="${String(cursor)}"]`
		);
		el?.scrollIntoView({ block: "nearest" });
	}, [cursor, open]);

	function pick(m: PiModelInfo): void {
		setOpen(false);
		onPick(m);
	}

	function onKeyDown(e: React.KeyboardEvent): void {
		if (e.key === "Escape") {
			e.preventDefault();
			setOpen(false);
			return;
		}
		if (e.key === "ArrowDown") {
			e.preventDefault();
			setCursor((c) => Math.min(c + 1, Math.max(flat.length - 1, 0)));
			return;
		}
		if (e.key === "ArrowUp") {
			e.preventDefault();
			setCursor((c) => Math.max(c - 1, 0));
			return;
		}
		if (e.key === "Enter") {
			e.preventDefault();
			const m = flat[cursor];
			if (m !== undefined) pick(m);
		}
	}

	const label =
		current !== undefined ? current.name : models.length > 0 ? "Select model" : "no model";

	// Flat render-order index counter, reset per render; must mirror `flat`.
	let nextFlatIdx = 0;

	return (
		<span className="relative">
			<button
				type="button"
				data-testid="model-picker-trigger"
				title="Change model"
				aria-haspopup="listbox"
				aria-expanded={open}
				onClick={() => setOpen((v) => !v)}
				className="flex max-w-[180px] items-center gap-1 rounded-md bg-neutral-800 px-2 py-1 font-mono text-[10px] text-neutral-300 transition-colors hover:bg-neutral-700"
			>
				<span className="truncate">{label}</span>
				<ChevronUp
					size={10}
					strokeWidth={2}
					className={`shrink-0 text-neutral-500 transition-transform ${open ? "rotate-180" : ""}`}
				/>
			</button>

			{open && (
				<>
					{/* Click-away catcher: transparent, covers the window. */}
					<div
						className="fixed inset-0 z-40"
						onMouseDown={() => setOpen(false)}
						data-testid="model-picker-backdrop"
					/>
					<div
						role="listbox"
						data-testid="model-picker-popover"
						className="absolute bottom-full left-0 z-50 mb-2 w-[340px] overflow-hidden rounded-xl border border-neutral-700 bg-neutral-900 shadow-2xl shadow-black/60"
					>
						<div className="border-b border-neutral-800 p-2">
							<div className="relative">
								<Search
									size={12}
									strokeWidth={2}
									className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-neutral-500"
								/>
								<input
									ref={inputRef}
									value={query}
									onChange={(e) => {
										setQuery(e.target.value);
										setCursor(0);
									}}
									onKeyDown={onKeyDown}
									placeholder={`Search ${String(models.length)} models…`}
									spellCheck={false}
									className="w-full rounded-md bg-neutral-800 py-1.5 pl-8 pr-2.5 text-xs text-neutral-200 outline-none placeholder:text-neutral-500 focus:ring-1 focus:ring-blue-600"
								/>
							</div>
						</div>
						<div ref={listRef} className="max-h-[40vh] overflow-y-auto py-1">
							{flat.length === 0 && (
								<div className="px-3 py-4 text-center text-xs text-neutral-500">
									No models match “{query}”
								</div>
							)}
							{groups.map(([provider, ms]) => (
								<div key={provider}>
									<div className="sticky top-0 bg-neutral-900 px-3 pb-1 pt-1.5 text-[9px] uppercase tracking-wide text-neutral-500">
										{provider}
									</div>
									{ms.map((m) => {
										// Running counter, NOT flat.indexOf(m): indexOf inside the
										// map made each render O(n²) over the catalog (audit 6 L-12).
										const idx = nextFlatIdx++;
										const active = current !== undefined && current.provider === m.provider && current.id === m.id;
										return (
											<button
												key={`${m.provider}:${m.id}`}
												type="button"
												role="option"
												aria-selected={active}
												data-idx={idx}
												onClick={() => pick(m)}
												onMouseMove={() => setCursor(idx)}
												className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs ${
													idx === cursor ? "bg-neutral-800" : ""
												} ${active ? "text-accent-strong" : "text-neutral-300"}`}
											>
												<span className="min-w-0 flex-1 truncate">{m.name}</span>
												{m.reasoning && (
													<span className="rounded bg-info-soft px-1 text-[8px] text-info">
														thinking
													</span>
												)}
												<span className="font-mono text-[9px] text-neutral-500">
													{Math.round(m.contextWindow / 1000)}k
												</span>
												{active && (
												<Check size={11} strokeWidth={2.5} className="shrink-0 text-accent-strong" />
											)}
											</button>
										);
									})}
								</div>
							))}
						</div>
					</div>
				</>
			)}
		</span>
	);
}
