/**
 * Embedded terminal: xterm.js over node-pty, scoped to the session cwd.
 */
import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

export function TerminalPanel({ cwd }: { cwd: string }): React.JSX.Element {
	const containerRef = useRef<HTMLDivElement>(null);
	const termRef = useRef<Terminal | null>(null);
	const fitRef = useRef<FitAddon | null>(null);
	const ptyIdRef = useRef<string>(`pty-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);

	useEffect(() => {
		const container = containerRef.current;
		if (container === null) return;

		const term = new Terminal({
			fontSize: 11,
			fontFamily: "SF Mono, Menlo, monospace",
			theme: {
				background: "#111113",
				foreground: "#e5e5e8",
				cursor: "#5b9bf8",
			},
			cursorBlink: true,
		});
		const fit = new FitAddon();
		term.loadAddon(fit);
		term.open(container);
		termRef.current = term;
		fitRef.current = fit;

		const ptyId = ptyIdRef.current;
		term.onData((data) => window.piDesktop.pty.write(ptyId, data));
		const unsubscribe = window.piDesktop.pty.onData(ptyId, (data) => term.write(data));

		function fitNow(): void {
			const el = containerRef.current;
			if (el !== null && el.clientWidth > 0 && el.clientHeight > 0) {
				fit.fit();
				window.piDesktop.pty.resize(ptyId, term.cols, term.rows);
			}
		}
		fitNow();
		window.piDesktop.pty.create({
			id: ptyId,
			cwd,
			cols: term.cols,
			rows: term.rows,
		});

		const observer = new ResizeObserver(() => fitNow());
		observer.observe(container);

		return () => {
			observer.disconnect();
			unsubscribe();
			window.piDesktop.pty.kill(ptyId);
			term.dispose();
			termRef.current = null;
		};
	}, [cwd]);

	return <div ref={containerRef} className="h-full w-full p-1" />;
}
