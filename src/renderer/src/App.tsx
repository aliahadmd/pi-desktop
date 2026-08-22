/**
 * App shell v2 (phase 3): Sidebar | Center | Dock three-column layout.
 * Sheets for Models/Settings/Trust/Browse-all; motion throughout.
 */
import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { bindPiEvents, useSessions } from "./stores/pi-sessions";
import ChatPage from "./pages/ChatPage";
import { ModelsPage } from "./pages/ModelsPage";
import { SettingsPage } from "./pages/SettingsPage";
import { TrustPanel } from "./pages/TrustPanel";
import { SessionsPage } from "./pages/SessionsPage";
import { Onboarding } from "./pages/Onboarding";
import { PackageMarketplace } from "./pages/PackageMarketplace";
import { Sheet } from "./components/shell/Sheet";
import { Sidebar } from "./components/shell/Sidebar";

type SheetKind = "models" | "settings" | "trust" | "browse" | "packages" | null;

export default function App(): React.JSX.Element {

	const [showOnboarding, setShowOnboarding] = useState(false);
	const [onboardingChecked, setOnboardingChecked] = useState(false);
	const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
	const [sheet, setSheet] = useState<SheetKind>(null);

	useEffect(() => bindPiEvents(), []);

	useEffect(() => {
		void window.piDesktop.invoke({ type: "auth.providers" }).then((r) => {
			setOnboardingChecked(true);
			if (!r.ok) return;
			const anyConfigured = (
				r.data as { providers: Array<{ configured: boolean }> }
			).providers.some((p) => p.configured);
			if (!anyConfigured) setShowOnboarding(true);
		});
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
		<div className="flex h-full overflow-hidden">
			<AnimatePresence initial={false} mode="wait">
				<motion.div
					key={sidebarCollapsed ? "rail" : "full"}
					initial={false}
					animate={{
						width: sidebarCollapsed ? "var(--sidebar-rail-w)" : "var(--sidebar-w)",
					}}
					transition={{ duration: 0.2, ease: [0.2, 0, 0, 1] }}
					className="shrink-0 overflow-hidden"
				>
					<Sidebar
						collapsed={sidebarCollapsed}
						onOpenSession={(response) => {
							useSessions.getState().open(response);
							setSheet(null);
						}}
						onOpenSheet={(kind) => setSheet(kind)}
					/>
				</motion.div>
			</AnimatePresence>

			<main className="relative flex min-w-0 flex-1 flex-col overflow-hidden">
				<div className="titlebar-drag flex h-3 shrink-0 items-center" />

				<AnimatePresence>
					{showOnboarding && onboardingChecked && (
						<Onboarding
							onDone={() => {
								setShowOnboarding(false);
							}}
						/>
					)}
				</AnimatePresence>

				<ChatPage />


			</main>

			{/* Sheets */}
			<Sheet
				open={sheet === "models"}
				title="Models"
				onClose={() => setSheet(null)}
				testId="sheet-models"
			>
				<ModelsPage
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
				<SettingsPage />
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
		</div>
	);
}
