import React from "react";
import ReactDOM from "react-dom/client";
import { MotionConfig } from "motion/react";
import App from "./App";
import "./index.css";

// Forward renderer console to the main-process file log (best effort).
for (const level of ["info", "warn", "error"] as const) {
	const original = console[level].bind(console);
	console[level] = (...args: unknown[]): void => {
		original(...args);
		void window.piDesktop
			.invoke({
				type: "log_write",
				level,
				args: args.map((a) => String(a)),
			})
			.catch(() => {});
	};
}

// Boot handshake (audit 6 L-3): ping was contract surface with no caller. One
// round-trip at startup verifies the invoke path end-to-end and lands the
// main/electron versions in the file log for support diagnostics.
void window.piDesktop
	.invoke({ type: "ping" })
	.then((r) => {
		if (r.ok) {
			console.info(`main ${r.data.mainVersion} · electron ${r.data.electronVersion}`);
		}
	})
	.catch(() => {});

ReactDOM.createRoot(document.getElementById("root")!).render(
	<React.StrictMode>
		{/* reducedMotion="user": the CSS kill-switch (index.css) only reaches
		    stylesheet animations; this makes every motion/react animation honor
		    the OS reduced-motion setting too (audit 6 L-14). */}
		<MotionConfig reducedMotion="user">
			<App />
		</MotionConfig>
	</React.StrictMode>
);
