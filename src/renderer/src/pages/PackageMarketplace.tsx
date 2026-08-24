/**
 * Package Marketplace (phase 4): browse, search, and install pi packages
 * from npm. Full-window sheet with categorized listings.
 */
import { useCallback, useEffect, useState } from "react";
import type { NpmSearchResult } from "../../../shared/pi";

interface InstalledPackage {
	source: string;
	scope: string;
	filtered: boolean;
	installedPath?: string;
}

function categorize(_name: string, desc: string): string {
	const d = desc.toLowerCase();
	if (d.includes("skill") || d.includes("agent")) return "Skills & Agents";
	if (d.includes("ui") || d.includes("theme") || d.includes("footer") || d.includes("tweak")) return "UI & Themes";
	if (d.includes("web") || d.includes("search") || d.includes("browser") || d.includes("fetch")) return "Web & Search";
	if (d.includes("subagent") || d.includes("task") || d.includes("delegate")) return "Workflow";
	if (d.includes("terminal") || d.includes("cmux") || d.includes("tool")) return "Developer Tools";
	return "Utilities";
}

function timeAgo(dateStr: string): string {
	try {
		const diff = Date.now() - new Date(dateStr).getTime();
		if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
		return `${Math.floor(diff / 86_400_000)}d ago`;
	} catch {
		return "";
	}
}

export function PackageMarketplace(): React.JSX.Element {
	const [results, setResults] = useState<NpmSearchResult[]>([]);
	const [installed, setInstalled] = useState<InstalledPackage[]>([]);
	const [filter, setFilter] = useState("");
	const [searching, setSearching] = useState(true);
	const [installing, setInstalling] = useState<string | null>(null);
	const [message, setMessage] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);

	const load = useCallback(async (): Promise<void> => {
		setSearching(true);
		try {
			const search = await window.piDesktop.invoke({ type: "packages.search" });
			if (search.ok) setResults(search.data.results);
			else setError(search.error.message);
			const list = await window.piDesktop.invoke({ type: "packages.list" });
			if (list.ok) setInstalled(list.data.packages);
		} finally {
			setSearching(false);
		}
	}, []);

	useEffect(() => {
		void load();
	}, [load]);

	const installedSources = new Set(installed.map((p) => p.source));
	const filtered = results.filter(
		(r) =>
			r.name.toLowerCase().includes(filter.toLowerCase()) ||
			r.description.toLowerCase().includes(filter.toLowerCase())
	);
	const categories = new Map<string, NpmSearchResult[]>();
	for (const r of filtered) {
		const cat = categorize(r.name, r.description);
		const list = categories.get(cat) ?? [];
		list.push(r);
		groups_set(categories, cat, list);
	}
	function groups_set(map: Map<string, NpmSearchResult[]>, key: string, val: NpmSearchResult[]): void {
		map.set(key, val);
	}

	async function install(name: string): Promise<void> {
		setInstalling(name);
		setError(null);
		setMessage(null);
		try {
			const result = await window.piDesktop.invoke({
				type: "packages.install",
				source: `npm:${name}`,
			});
			if (result.ok) {
				setMessage(`Installed ${name}. Restart sessions to load.`);
				await load();
			} else {
				setError(result.error.message);
			}
		} finally {
			setInstalling(null);
		}
	}

	async function remove(name: string): Promise<void> {
		setInstalling(name);
		try {
			await window.piDesktop.invoke({ type: "packages.remove", source: `npm:${name}` });
			setMessage(`Removed ${name}.`);
			await load();
		} finally {
			setInstalling(null);
		}
	}

	return (
		<div className="h-full overflow-y-auto p-6">
			<div className="mx-auto max-w-3xl">
				<h1 className="text-2xl font-bold text-neutral-100">Package Marketplace</h1>
				<p className="mt-1 text-sm text-neutral-400">
					Extend Pi Desktop with skills, commands, and extensions from packages.
				</p>

				{error !== null && (
					<div className="mt-3 rounded border border-danger/40 bg-danger-soft/50 px-3 py-2 text-xs text-red-300">
						{error}
					</div>
				)}
				{message !== null && (
					<div className="mt-3 rounded border border-success/40 bg-success-soft px-3 py-2 text-xs text-success">
						{message}
					</div>
				)}

				{/* Search */}
				<input
					value={filter}
					onChange={(e) => setFilter(e.target.value)}
					placeholder="Search packages…"
					className="mt-5 w-full rounded-lg border border-neutral-700 bg-neutral-900 px-4 py-2.5 text-sm outline-none focus:border-blue-500"
				/>

				{/* Installed */}
				{installed.length > 0 && (
					<div className="mt-6">
						<div className="mb-2 flex items-center justify-between">
							<h3 className="text-xs font-semibold tracking-wide text-neutral-400 uppercase">
								Installed ({installed.length})
							</h3>
						</div>
						<div className="flex flex-wrap gap-2">
							{installed.map((p) => (
								<button
									key={p.source}
									type="button"
									onClick={() => void remove(p.source)}
									title="Click to remove"
									className="rounded-lg border border-neutral-700 bg-neutral-800 px-3 py-1.5 text-xs text-neutral-300 hover:border-red-800 hover:text-danger"
								>
									{p.source.replace("npm:", "")}
								</button>
							))}
						</div>
					</div>
				)}

				{/* Categories */}
				{searching ? (
					<div className="mt-8 flex flex-col gap-3">
						{[1, 2, 3, 4, 5].map((i) => (
							<div key={i} className="skeleton h-14 rounded-lg" />
						))}
					</div>
				) : (
					[...categories.entries()].map(([cat, list]) => (
						<div key={cat} className="mt-8">
							<h3 className="mb-3 text-sm font-semibold text-neutral-200">{cat}</h3>
							<div className="flex flex-col gap-2">
								{list.map((pkg) => {
									const isInstalled = installedSources.has(`npm:${pkg.name}`);
									return (
										<div
											key={pkg.name}
											className="flex items-center gap-3 rounded-lg border border-neutral-800 bg-app-surface/50 px-4 py-3"
										>
											<span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-neutral-800 text-sm font-bold text-accent-strong">
												{pkg.name.replace(/[^a-zA-Z]/g, "").slice(0, 1).toUpperCase()}
											</span>
											<div className="min-w-0 flex-1">
												<div className="flex items-center gap-2">
													<span className="text-sm font-medium text-neutral-100">{pkg.name}</span>
													<span className="font-mono text-[9px] text-neutral-600">v{pkg.version}</span>
												</div>
												<p className="mt-0.5 truncate text-xs text-neutral-500">{pkg.description}</p>
											</div>
											<span className="shrink-0 font-mono text-[9px] text-neutral-700">
												{timeAgo(pkg.date)}
											</span>
											{isInstalled ? (
												<button
													type="button"
													disabled={installing === pkg.name}
													onClick={() => void remove(pkg.name)}
													className="shrink-0 rounded bg-neutral-800 px-3 py-1 text-xs text-neutral-400 hover:bg-danger-soft hover:text-danger disabled:opacity-40"
												>
													Remove
												</button>
											) : (
												<button
													type="button"
													disabled={installing === pkg.name}
													onClick={() => void install(pkg.name)}
													className="shrink-0 rounded bg-blue-600 px-3 py-1 text-xs text-on-accent hover:bg-blue-500 disabled:opacity-40"
												>
													{installing === pkg.name ? "…" : "Install"}
												</button>
											)}
										</div>
									);
								})}
							</div>
						</div>
					))
				)}
			</div>
		</div>
	);
}
