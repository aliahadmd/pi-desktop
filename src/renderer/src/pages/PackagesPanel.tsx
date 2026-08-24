/**
 * Pi packages manager (chapter 11): list/install/remove via the
 * programmatic PackageManager API with a trust interstitial.
 */
import { useCallback, useEffect, useState } from "react";

interface ConfiguredPackage {
	source: string;
	scope: string;
	filtered: boolean;
	installedPath?: string;
}

export function PackagesPanel(): React.JSX.Element {
	const [packages, setPackages] = useState<ConfiguredPackage[]>([]);
	const [source, setSource] = useState("");
	const [pendingSource, setPendingSource] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [message, setMessage] = useState<string | null>(null);

	const load = useCallback(async (): Promise<void> => {
		const result = await window.piDesktop.invoke({ type: "packages.list" });
		if (result.ok) setPackages(result.data.packages);
	}, []);

	useEffect(() => {
		void load();
	}, [load]);

	async function beginInstall(): Promise<void> {
		if (source.trim().length === 0) return;
		setPendingSource(source.trim());
	}

	async function confirmInstall(): Promise<void> {
		if (pendingSource === null) return;
		setBusy(true);
		setMessage(null);
		try {
			const result = await window.piDesktop.invoke({
				type: "packages.install",
				source: pendingSource,
			});
			if (result.ok) {
				const steps = (result.data as { progress?: string[] }).progress ?? [];
				setMessage(
					`Installed ${pendingSource}. Restart sessions to load its resources.` +
						(steps.length > 0 ? ` (${steps.length} steps)` : "")
				);
			} else {
				setMessage(`Install failed: ${result.error.message}`);
			}
			await load();
			setSource("");
		} finally {
			setBusy(false);
			setPendingSource(null);
		}
	}

	async function remove(pkg: ConfiguredPackage): Promise<void> {
		setBusy(true);
		try {
			await window.piDesktop.invoke({ type: "packages.remove", source: pkg.source });
			await load();
		} finally {
			setBusy(false);
		}
	}

	return (
		<div>
			<div className="mb-2 flex items-center justify-between">
				<div>
					<div className="text-sm text-neutral-200">Pi packages</div>
					<div className="text-[10px] text-neutral-500">
						npm:, git:, URL or local path sources. Extensions run with full system access — review before installing.
					</div>
				</div>
			</div>

			{message !== null && (
				<div className="mb-2 rounded border border-neutral-700 bg-neutral-900 px-3 py-1.5 text-[11px] text-neutral-300">
					{message}
				</div>
			)}

			{pendingSource !== null ? (
				<div className="mb-3 rounded border border-amber-900 bg-amber-950/40 p-3">
					<div className="text-xs font-medium text-amber-200">Trust this package?</div>
					<p className="mt-1 font-mono text-[10px] text-neutral-300">{pendingSource}</p>
					<p className="mt-1 text-[10px] text-neutral-400">
						Packages execute arbitrary code and can instruct the model to run anything.
					</p>
					<div className="mt-2 flex gap-2">
						<button
							type="button"
							disabled={busy}
							onClick={() => void confirmInstall()}
							className="rounded bg-blue-600 px-3 py-1 text-xs text-on-accent hover:bg-blue-500 disabled:opacity-40"
						>
							Trust & install
						</button>
						<button
							type="button"
							onClick={() => setPendingSource(null)}
							className="rounded bg-neutral-800 px-3 py-1 text-xs text-neutral-300 hover:bg-neutral-700"
						>
							Cancel
						</button>
					</div>
				</div>
			) : (
				<div className="mb-3 flex gap-1.5">
					<input
						value={source}
						onChange={(e) => setSource(e.target.value)}
						placeholder="npm:@scope/pkg@1.0 | git:github.com/user/repo | /path"
						className="flex-1 rounded border border-neutral-700 bg-neutral-900 px-2.5 py-1.5 font-mono text-[11px] outline-none focus:border-blue-500"
					/>
					<button
						type="button"
						disabled={busy || source.trim().length === 0}
						onClick={() => void beginInstall()}
						className="rounded bg-blue-600 px-3 py-1.5 text-xs text-on-accent hover:bg-blue-500 disabled:opacity-40"
					>
						Install…
					</button>
				</div>
			)}

			{packages.length === 0 ? (
				<p className="text-xs text-neutral-600">No packages configured.</p>
			) : (
				packages.map((pkg) => (
					<div
						key={pkg.source + pkg.scope}
						className="flex items-center gap-2 border-b border-neutral-800/60 py-2"
					>
						<span className="min-w-0 flex-1 truncate font-mono text-xs text-neutral-300">
							{pkg.source}
						</span>
						<span className="rounded bg-neutral-800 px-1.5 py-0.5 text-[9px] text-neutral-500">
							{pkg.scope}
						</span>
						<button
							type="button"
							disabled={busy}
							onClick={() => void remove(pkg)}
							className="rounded px-2 py-0.5 text-[10px] text-neutral-500 hover:bg-danger-soft hover:text-danger"
						>
							Remove
						</button>
					</div>
				))
			)}
		</div>
	);
}
