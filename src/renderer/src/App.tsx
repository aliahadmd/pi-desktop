/**
 * App shell: Chat / Sessions tabs. Binds the global pi event stream once.
 */
import { useEffect, useState } from "react";
import { bindPiEvents, useSessions } from "./stores/pi-sessions";
import ChatPage from "./pages/ChatPage";
import { SessionsPage } from "./pages/SessionsPage";
import { ModelsPage } from "./pages/ModelsPage";
import { SettingsPage } from "./pages/SettingsPage";
import { Onboarding } from "./pages/Onboarding";
import { TrustPanel } from "./pages/TrustPanel";

type Tab = "chat" | "sessions" | "models" | "settings" | "trust";

export default function App(): React.JSX.Element {
	const [tab, setTab] = useState<Tab>("chat");
	const [pingOk, setPingOk] = useState(false);
	const [showOnboarding, setShowOnboarding] = useState(false);
	const [onboardingChecked, setOnboardingChecked] = useState(false);

	useEffect(() => bindPiEvents(), []);

	useEffect(() => {
		void window.piDesktop.invoke({ type: "ping" }).then((r) => {
			if (r.ok) setPingOk(true);
		});
		// First-run check: any configured provider auth?
		void window.piDesktop.invoke({ type: "auth.providers" }).then((r) => {
			setOnboardingChecked(true);
			if (!r.ok) return;
			const anyConfigured = (r.data as { providers: Array<{ configured: boolean }> }).providers.some(
				(p) => p.configured
			);
			if (!anyConfigured) setShowOnboarding(true);
		});
	}, []);

	return (
		<div className="flex h-full flex-col">
			<header className="titlebar-drag flex h-12 shrink-0 items-center px-20">
				<h1 className="text-sm font-semibold tracking-wide text-neutral-300">
					Pi Desktop
				</h1>
				<nav className="titlebar-nodrag ml-6 flex gap-1">
					<button
						type="button"
						onClick={() => setTab("chat")}
						data-testid="tab-chat"
						className={`rounded px-3 py-1 text-xs ${
							tab === "chat"
								? "bg-neutral-800 text-neutral-100"
								: "text-neutral-500 hover:text-neutral-300"
						}`}
					>
						Chat
					</button>
					<button
						type="button"
						onClick={() => setTab("sessions")}
						data-testid="tab-sessions"
						className={`rounded px-3 py-1 text-xs ${
							tab === "sessions"
								? "bg-neutral-800 text-neutral-100"
								: "text-neutral-500 hover:text-neutral-300"
						}`}
					>
						Sessions
					</button>
					<button
						type="button"
						onClick={() => setTab("models")}
						data-testid="tab-models"
						className={`rounded px-3 py-1 text-xs ${
							tab === "models"
								? "bg-neutral-800 text-neutral-100"
								: "text-neutral-500 hover:text-neutral-300"
						}`}
					>
						Models
					</button>
					<button
						type="button"
						onClick={() => setTab("settings")}
						data-testid="tab-settings"
						className={`rounded px-3 py-1 text-xs ${
							tab === "settings"
								? "bg-neutral-800 text-neutral-100"
								: "text-neutral-500 hover:text-neutral-300"
						}`}
					>
						Settings
					</button>
					<button
						type="button"
						onClick={() => setTab("trust")}
						data-testid="tab-trust"
						className={`rounded px-3 py-1 text-xs ${
							tab === "trust"
								? "bg-neutral-800 text-neutral-100"
								: "text-neutral-500 hover:text-neutral-300"
						}`}
					>
						Trust
					</button>
				</nav>
				{pingOk && (
					<span className="ml-auto font-mono text-[10px] text-neutral-600">ipc ok</span>
				)}
			</header>
			<main className="relative flex flex-1 flex-col overflow-hidden">
				{tab === "chat" ? (
					<ChatPage />
				) : tab === "sessions" ? (
					<SessionsPage
						onResume={(response) => {
							useSessions.getState().open(response);
							setTab("chat");
						}}
					/>
				) : tab === "models" ? (
					<ModelsPage
						onUseWithSession={(provider, modelId) => {
							void window.piDesktop.invoke({
								type: "session.default_model",
								provider,
								modelId,
							});
							setTab("chat");
						}}
					/>
				) : tab === "trust" ? (
					<TrustPanel />
				) : (
					<SettingsPage />
				)}
				{showOnboarding && onboardingChecked && (
					<Onboarding
						onDone={() => {
							setShowOnboarding(false);
						}}
					/>
				)}
			</main>
		</div>
	);
}
