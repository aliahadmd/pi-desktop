import React from "react";
import ReactDOM from "react-dom/client";
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

ReactDOM.createRoot(document.getElementById("root")!).render(
	<React.StrictMode>
		<App />
	</React.StrictMode>
);
