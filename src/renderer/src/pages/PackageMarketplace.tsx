/**
 * Package Marketplace (phase 4): browse, search, and install pi packages.
 * The catalog comes from the npm registry `pi-package` keyword search — the
 * same data source as pi.dev/packages — with monthly downloads and kind
 * chips (extension/skill/prompt/theme). Manual source installs (npm:, git:,
 * URL, local path) live here too; every install is gated by the trust
 * interstitial.
 */
import { useCallback, useEffect, useState } from "react";
import type { NpmSearchResult } from "../../../shared/pi";

interface InstalledPackage {
	source: string;
	scope: string;
	filtered: boolean;
	installedPath?: string;
}

const KIND_ORDER = ["extension", "skill", "prompt", "theme"] as const;
type KindFilter = "all" | (typeof KIND_ORDER)[number] | "package";

function kindsOf(keywords: string[]): string[] {
	const kinds = KIND_ORDER.filter((k) => keywords.includes(k));
	return kinds.length > 0 ? [...kinds] : ["package"];
}

function formatDownloads(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M/mo`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K/mo`;
	return `${n}/mo`;
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

/** Catalog rows arm the interstitial with a bare npm name; the manual input
 * may carry an explicit source (npm:, git:, https:, /path, ./path). */
function toSource(name: string): string {
	return /^[a-z][a-z0-9+.-]*:/i.test(name) || name.startsWith("/") || name.startsWith(".")
		? name
		: `npm:${name}`;
}

const PAGE = 60;

export function PackageMarketplace(): React.JSX.Element {
	const [results, setResults] = useState<NpmSearchResult[]>([]);
	const [installed, setInstalled] = useState<InstalledPackage[]>([]);
	const [filter, setFilter] = useState("");
	const [kind, setKind] = useState<KindFilter>("all");
	const [shown, setShown] = useState(PAGE);
	const [searching, setSearching] = useState(true);
	const [installing, setInstalling] = useState<string | null>(null);
	/** Non-null: the trust interstitial is up for this package/source (audit 6 M-24). */
	const [pendingInstall, setPendingInstall] = useState<string | null>(null);
	const [manualSource, setManualSource] = useState("");
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
	const text = filter.trim().toLowerCase();
	const filtered = results.filter(
		(r) =>
			(kind === "all" || kindsOf(r.keywords).includes(kind)) &&
			(text.length === 0 ||
				r.name.toLowerCase().includes(text) ||
				r.description.toLowerCase().includes(text))
	);
	const limit = text.length > 0 || kind !== "all" ? 250 : shown;
	const visible = filtered.slice(0, limit);

	// Marketplace installs go through the SAME trust interstitial as the manual
	// source install (audit 6 M-24): a pi package is arbitrary code execution,
	// so one-click install from a browse surface was the wrong default.
	async function confirmInstall(): Promise<void> {
		if (pendingInstall === null) return;
		const source = toSource(pendingInstall);
		setInstalling(source);
		setError(null);
		setMessage(null);
		try {
			const result = await window.piDesktop.invoke({
				type: "packages.install",
				source,
			});
			if (result.ok) {
				setMessage(`Installed ${source}. Restart sessions to load.`);
				setManualSource("");
				await load();
			} else {
				setError(result.error.message);
			}
		} finally {
			setInstalling(null);
			setPendingInstall(null);
		}
	}

	/** Takes the FULL source ("npm:<name>") — never re-prefix it (audit 6 M-23). */
	async function remove(source: string): Promise<void> {
		setInstalling(source);
		setError(null);
		setMessage(null);
		try {
			const result = await window.piDesktop.invoke({ type: "packages.remove", source });
			// The envelope must be checked: "Removed" on a failed call was a lie.
			if (result.ok) {
				setMessage(`Removed ${source.replace(/^npm:/, "")}.`);
				await load();
			} else {
				setError(`Remove failed: ${result.error.message}`);
			}
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
					<div className="mt-3 flex items-center gap-2 rounded border border-danger/40 bg-danger-soft/50 px-3 py-2 text-xs text-red-300">
						<span className="min-w-0 flex-1">{error}</span>
						<button
							type="button"
							onClick={() => {
								setError(null);
								void load();
							}}
							className="shrink-0 rounded bg-neutral-800 px-2.5 py-1 text-[11px] text-neutral-300 hover:bg-neutral-700"
						>
							Retry
						</button>
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

				{/* Kind filter */}
				<div className="mt-3 flex flex-wrap gap-1.5">
					{(["all", ...KIND_ORDER, "package"] as KindFilter[]).map((k) => (
						<button
							key={k}
							type="button"
							onClick={() => setKind(k)}
							className={`rounded-full px-3 py-1 text-[11px] capitalize ${
								kind === k
									? "bg-blue-600 text-on-accent"
									: "bg-neutral-800 text-neutral-400 hover:bg-neutral-700"
							}`}
						>
							{k === "all" ? "All" : `${k}s`}
						</button>
					))}
				</div>

				{/* Trust interstitial (M-24): catalog rows and the manual install
				    input both arm this same gate. */}
				{pendingInstall !== null && (
					<div
						className="mt-4 rounded border border-amber-900 bg-amber-950/40 p-3"
						data-testid="marketplace-trust-interstitial"
					>
						<div className="text-xs font-medium text-amber-200">Trust this package?</div>
						<p className="mt-1 font-mono text-[10px] text-neutral-300">{toSource(pendingInstall)}</p>
						<p className="mt-1 text-[10px] text-neutral-400">
							Packages execute arbitrary code and can instruct the model to run anything.
						</p>
						<div className="mt-2 flex gap-2">
							<button
								type="button"
								disabled={installing !== null}
								onClick={() => void confirmInstall()}
								className="rounded bg-blue-600 px-3 py-1 text-xs text-on-accent hover:bg-blue-500 disabled:opacity-40"
							>
								{installing !== null ? "Installing…" : "Trust & install"}
							</button>
							<button
								type="button"
								onClick={() => setPendingInstall(null)}
								className="rounded bg-neutral-800 px-3 py-1 text-xs text-neutral-300 hover:bg-neutral-700"
							>
								Cancel
							</button>
						</div>
					</div>
				)}

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

				{/* Manual source install (moved out of Settings → here). */}
				<div className="mt-6 rounded-lg border border-neutral-800 bg-app-surface/50 p-4">
					<div className="text-sm text-neutral-200">Install from source</div>
					<div className="mt-0.5 text-[10px] text-neutral-500">
						npm:, git:, URL or local path sources. Extensions run with full system access — review
						before installing.
					</div>
					<div className="mt-2 flex gap-1.5">
						<input
							value={manualSource}
							onChange={(e) => setManualSource(e.target.value)}
							placeholder="npm:@scope/pkg@1.0 | git:github.com/user/repo | /path"
							className="flex-1 rounded border border-neutral-700 bg-neutral-900 px-2.5 py-1.5 font-mono text-[11px] outline-none focus:border-blue-500"
						/>
						<button
							type="button"
							disabled={installing !== null || manualSource.trim().length === 0}
							onClick={() => setPendingInstall(manualSource.trim())}
							className="rounded bg-blue-600 px-3 py-1.5 text-xs text-on-accent hover:bg-blue-500 disabled:opacity-40"
						>
							Install…
						</button>
					</div>
				</div>

				{/* Catalog */}
				{searching ? (
					<div className="mt-8 flex flex-col gap-3">
						{[1, 2, 3, 4, 5].map((i) => (
							<div key={i} className="skeleton h-14 rounded-lg" />
						))}
					</div>
				) : (
					<>
						<div className="mt-6 mb-3 text-xs text-neutral-500">
							{filtered.length.toLocaleString()} packages
						</div>
						<div className="flex flex-col gap-2">
							{visible.map((pkg) => {
								const isInstalled = installedSources.has(`npm:${pkg.name}`);
								const kinds = kindsOf(pkg.keywords);
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
												<span className="truncate text-sm font-medium text-neutral-100">{pkg.name}</span>
												<span className="shrink-0 font-mono text-[9px] text-neutral-600">v{pkg.version}</span>
												{kinds.map((k) => (
													<span
														key={k}
														className="shrink-0 rounded bg-neutral-800 px-1.5 py-0.5 text-[9px] text-neutral-400"
													>
														{k}
													</span>
												))}
											</div>
											<p className="mt-0.5 truncate text-xs text-neutral-500">{pkg.description}</p>
										</div>
										<span className="shrink-0 font-mono text-[9px] text-neutral-500">
											{formatDownloads(pkg.downloads)}
										</span>
										<span className="shrink-0 font-mono text-[9px] text-neutral-700">
											{timeAgo(pkg.date)}
										</span>
										{isInstalled ? (
											<button
												type="button"
												disabled={installing === `npm:${pkg.name}`}
												onClick={() => void remove(`npm:${pkg.name}`)}
												className="shrink-0 rounded bg-neutral-800 px-3 py-1 text-xs text-neutral-400 hover:bg-danger-soft hover:text-danger disabled:opacity-40"
											>
												Remove
											</button>
										) : (
											<button
												type="button"
												disabled={installing === pkg.name}
												onClick={() => setPendingInstall(pkg.name)}
												className="shrink-0 rounded bg-blue-600 px-3 py-1 text-xs text-on-accent hover:bg-blue-500 disabled:opacity-40"
											>
												Install…
											</button>
										)}
									</div>
								);
							})}
						</div>
						{filtered.length > limit && (
							<button
								type="button"
								onClick={() => setShown((n) => n + PAGE)}
								className="mt-4 w-full rounded-lg border border-neutral-800 bg-neutral-900 py-2 text-xs text-neutral-400 hover:bg-neutral-800"
							>
								Show more ({(filtered.length - limit).toLocaleString()} remaining)
							</button>
						)}
					</>
				)}
			</div>
		</div>
	);
}
