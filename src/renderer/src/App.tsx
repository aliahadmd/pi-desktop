/**
 * App shell v2 (phase 3): Sidebar | Center | Dock three-column layout.
 * Sheets for Models/Settings/Trust/Browse-all; motion throughout.
 */
import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { bindPiEvents, useSessions } from "./stores/pi-sessions";
import ChatPage, { refreshState, type DockTab } from "./pages/ChatPage";
import { applyTheme } from "./lib/apply-theme";
import { ThemeContext } from "./lib/theme-context";
import {
	DEFAULT_THEME_ID,
	isThemePresetId,
} from "../../shared/theme";
import { clampScale } from "../../shared/display";
import type { AuthPromptEvent } from "../../shared/protocol";
import { ModelsPage } from "./pages/ModelsPage";
import { SettingsPage } from "./pages/SettingsPage";
import { TrustPanel } from "./pages/TrustPanel";
import { SessionsPage } from "./pages/SessionsPage";
import { Onboarding } from "./pages/Onboarding";
import { TopBar } from "./components/shell/TopBar";
import { PackageMarketplace } from "./pages/PackageMarketplace";
import { Sheet } from "./components/shell/Sheet";
import { Sidebar } from "./components/shell/Sidebar";

type SheetKind = "models" | "settings" | "trust" | "browse" | "packages" | null;

export default function App(): React.JSX.Element {

	const [showOnboarding, setShowOnboarding] = useState(false);
	const [onboardingChecked, setOnboardingChecked] = useState(false);
	const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
	const [dockTab, setDockTab] = useState<DockTab>(null);
	const [compactOpen, setCompactOpen] = useState(false);
	const [sheet, setSheet] = useState<SheetKind>(null);
	const activeSessionId = useSessions((s) => s.activeId);
	const sessions = useSessions((s) => s.sessions);
	const reviewCount =
		activeSessionId !== null
			? (sessions[activeSessionId]?.blocks.filter(
					(b) => b.kind === "tool" && ["edit", "write"].includes(b.toolName),
				).length ?? 0)
			: 0;
	const [loginPrompt, setLoginPrompt] = useState<AuthPromptEvent | null>(null);
	const [loginValue, setLoginValue] = useState("");

	// OAuth flows that need pasted input (e.g. a redirect URL) surface as
	// auth_prompt bus events; without this listener they hang until timeout.
	useEffect(() => {
		return window.piDesktop.on((event) => {
			if (event.type === "auth_prompt") {
				setLoginValue("");
				setLoginPrompt(event);
			}
			if (event.type === "auth_notify") {
				setLoginPrompt((current) =>
					current !== null && current.loginId === event.loginId ? null : current
				);
			}
		});
	}, []);

	function respondLogin(value: string): void {
		if (loginPrompt === null) return;
		void window.piDesktop.invoke({
			type: "auth.respond_login",
			loginId: loginPrompt.loginId,
			value,
		});
		setLoginPrompt(null);
	}

	useEffect(() => bindPiEvents(), []);

	// Theme: read persisted preset once and apply before first interaction.
	// Exposed setter lets Settings + the top-bar cycler switch live.
	const [themeId, setThemeId] = useState<string>(DEFAULT_THEME_ID);
	useEffect(() => {
		void (async () => {
			const r = await window.piDesktop.invoke({
				type: "app.settings.get",
				key: "theme",
			});
			if (r.ok && isThemePresetId(r.data)) {
				setThemeId(r.data);
				applyTheme(r.data);
			}
		})();
	}, []);

	function changeTheme(next: string): void {
		if (!isThemePresetId(next)) return;
		setThemeId(next);
		applyTheme(next);
		void window.piDesktop.invoke({
			type: "app.settings.set",
			key: "theme",
			value: next,
		});
	}

	// UI scale: persisted fraction applied via webFrame zoom.
	const [uiScale, setUiScale] = useState<number>(1);
	useEffect(() => {
		void (async () => {
			const r = await window.piDesktop.invoke({
				type: "app.settings.get",
				key: "uiScale",
			});
			const s = clampScale(r.ok ? r.data : 1);
			setUiScale(s);
			window.electron.webFrame.setZoomFactor(s);
		})();
	}, []);

	function changeUiScale(next: number): void {
		const s = clampScale(next);
		setUiScale(s);
		window.electron.webFrame.setZoomFactor(s);
		void window.piDesktop.invoke({
			type: "app.settings.set",
			key: "uiScale",
			value: JSON.stringify(s),
		});
	}

	// Window transparency: renderer side sets a data attribute; the main
	// process decides window construction options at boot. Toggle reloads.
	const [transparency, setTransparency] = useState<boolean>(false);
	useEffect(() => {
		void (async () => {
			const r = await window.piDesktop.invoke({
				type: "app.settings.get",
				key: "windowTransparency",
			});
			const raw: unknown = r.ok ? r.data : undefined;
			const on = typeof raw === "string" ? JSON.parse(raw) === true : raw === true;
			if (on) {
				setTransparency(true);
				document.documentElement.dataset.transparency = "on";
			}
		})();
	}, []);

	function changeTransparency(on: boolean): void {
		setTransparency(on);
		document.documentElement.dataset.transparency = on ? "on" : "off";
		void window.piDesktop.invoke({
			type: "app.settings.set",
			key: "windowTransparency",
			value: JSON.stringify(on),
		});
	}

	useEffect(() => {
		void (async () => {
			// "Skip for now" must survive a relaunch: without a persisted flag the
			// modal reappeared on every launch until a provider was configured.
			const dismissed = await window.piDesktop.invoke({
				type: "app.settings.get",
				key: "onboardingDismissed",
			});
			const skipped = dismissed.ok && dismissed.data === true;
			const r = await window.piDesktop.invoke({ type: "auth.providers" });
			setOnboardingChecked(true);
			if (!r.ok) return;
			const anyConfigured = (
				r.data as { providers: Array<{ configured: boolean }> }
			).providers.some((p) => p.configured);
			if (!anyConfigured && !skipped) setShowOnboarding(true);
		})();
	}, []);

	// ⌘\ toggles sidebar collapse.
	useEffect(() => {
		const onKey = (e: KeyboardEvent): void => {
			if ((e.metaKey || e.ctrlKey) && e.key === "\\") {
				e.preventDefault();
				setSidebarCollapsed((v) => !v);
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, []);

	// Responsive: auto-collapse the sidebar on narrow windows (never auto-expand).
	useEffect(() => {
		const check = (): void => {
			if (window.innerWidth < 900) setSidebarCollapsed(true);
		};
		check();
		window.addEventListener("resize", check);
		return () => window.removeEventListener("resize", check);
	}, []);

	return (
		<ThemeContext.Provider value={themeId}>
		<div className="flex h-full flex-col overflow-hidden">
			{/* Top app bar: owns the sidebar toggle + window drag region.
			    Visible always — the restore control survives a hidden sidebar. */}
			<TopBar
				sidebarHidden={sidebarCollapsed}
				onToggleSidebar={() => setSidebarCollapsed((v) => !v)}
				themeId={themeId}
				onCycleTheme={changeTheme}
				activeSessionId={activeSessionId}
				dockTab={dockTab}
				reviewCount={reviewCount}
				onDockToggle={(tab) => setDockTab(dockTab === tab ? null : tab)}
				onCompact={() => {
					if (activeSessionId !== null) setCompactOpen(true);
				}}
				onExport={(format) => {
					if (activeSessionId === null) return;
					void window.piDesktop
						.invoke({
							type: format === "html" ? "session.export_html" : "session.export_jsonl",
							sessionId: activeSessionId,
						})
						.then((r) => {
							if (!r.ok) {
								useSessions.getState().pushErrorNotice(activeSessionId, r.error.message);
							}
						});
				}}
			/>

			<div className="flex min-h-0 flex-1 overflow-hidden">
			<AnimatePresence initial={false}>
				{!sidebarCollapsed && (
					<motion.div
						key="full"
						initial={false}
						animate={{ width: "var(--sidebar-w)" }}
						exit={{ width: 0, opacity: 0 }}
						transition={{ duration: 0.2, ease: [0.2, 0, 0, 1] }}
						className="shrink-0 overflow-hidden"
					>
						<Sidebar
							onOpenSession={(response) => {
								useSessions.getState().open(response);
								setSheet(null);
							}}
							onOpenSheet={(kind) => setSheet(kind)}
						/>
					</motion.div>
				)}
			</AnimatePresence>

			<main className="relative flex min-w-0 flex-1 flex-col overflow-hidden">
				<AnimatePresence>
					{showOnboarding && onboardingChecked && (
						<Onboarding
							onDone={() => {
								setShowOnboarding(false);
							}}
							onSkip={() => {
								setShowOnboarding(false);
								// Remember the dismissal; configuring a provider needs no
								// flag because the providers check covers that case.
								void window.piDesktop.invoke({
									type: "app.settings.set",
									key: "onboardingDismissed",
									value: JSON.stringify(true),
								});
							}}
						/>
					)}
				</AnimatePresence>

				<ChatPage
					onOpenSheet={(kind) => setSheet(kind)}
					dockTab={dockTab}
					setDockTab={setDockTab}
					compactOpen={compactOpen}
					setCompactOpen={setCompactOpen}
				/>


			</main>

			{/* Sheets */}
			<Sheet
				open={sheet === "models"}
				title="Models"
				onClose={() => setSheet(null)}
				testId="sheet-models"
			>
				<ModelsPage
					sessionOpen={activeSessionId !== null}
					onUseInSession={(provider, modelId) => {
						if (activeSessionId === null) return;
						void window.piDesktop
							.invoke({
								type: "session.set_model",
								sessionId: activeSessionId,
								provider,
								modelId,
							})
							.then((r) => {
								if (r.ok) {
									refreshState(activeSessionId);
								} else {
									useSessions.getState().pushErrorNotice(activeSessionId, r.error.message);
								}
							});
						setSheet(null);
					}}
					onUseWithSession={(provider, modelId) => {
						void window.piDesktop.invoke({
							type: "session.default_model",
							provider,
							modelId,
						});
						setSheet(null);
					}}
				/>
			</Sheet>
			<Sheet
				open={sheet === "settings"}
				title="Settings"
				onClose={() => setSheet(null)}
				testId="sheet-settings"
			>
				<SettingsPage
					themeId={themeId}
					onChangeTheme={changeTheme}
					uiScale={uiScale}
					onChangeUiScale={changeUiScale}
					transparency={transparency}
					onChangeTransparency={changeTransparency}
				/>
			</Sheet>
			<Sheet
				open={sheet === "trust"}
				title="Project trust & keybindings"
				onClose={() => setSheet(null)}
				testId="sheet-trust"
			>
				<TrustPanel />
			</Sheet>
			<Sheet
				open={sheet === "packages"}
				title="Package Marketplace"
				onClose={() => setSheet(null)}
				testId="sheet-packages"
			>
				<PackageMarketplace />
			</Sheet>
			<Sheet
				open={sheet === "browse"}
				title="All sessions"
				onClose={() => setSheet(null)}
				testId="sheet-browse"
			>
				<SessionsPage
					onResume={(response) => {
						useSessions.getState().open(response);
						setSheet(null);
					}}
				/>
			</Sheet>

			{loginPrompt !== null && (
				<div className="absolute inset-0 z-50 flex items-center justify-center bg-black/60">
					<div className="w-[440px] rounded-xl border border-neutral-700 bg-neutral-900 p-5" data-testid="auth-login-prompt">
						<h3 className="mb-1 text-sm font-semibold text-neutral-100">
							{loginPrompt.providerId} login
						</h3>
						<p className="mb-3 text-xs break-words text-neutral-400">
							{typeof loginPrompt.prompt === "string"
								? loginPrompt.prompt
								: "This provider needs input to finish the login."}
						</p>
						<input
							autoFocus
							value={loginValue}
							onChange={(e) => setLoginValue(e.target.value)}
							onKeyDown={(e) => {
								if (e.key === "Enter") respondLogin(loginValue);
								if (e.key === "Escape") respondLogin("");
							}}
							placeholder="Paste the value and press Enter…"
							className="mb-4 w-full rounded border border-neutral-700 bg-neutral-950 px-3 py-2 text-xs outline-none focus:border-blue-500"
						/>
						<div className="flex justify-end gap-2">
							<button
								type="button"
								onClick={() => respondLogin("")}
								className="rounded bg-neutral-800 px-3 py-1.5 text-xs hover:bg-neutral-700"
							>
								Cancel
							</button>
							<button
								type="button"
								data-testid="auth-login-submit"
								onClick={() => respondLogin(loginValue)}
								className="rounded bg-blue-600 px-3 py-1.5 text-xs text-white hover:bg-blue-500"
							>
								Submit
							</button>
						</div>
					</div>
				</div>
			)}
			</div>
		</div>
		</ThemeContext.Provider>
	);
}
