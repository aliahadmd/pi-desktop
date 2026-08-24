/// <reference types="vite/client" />
import type { PiDesktopBridge } from "../../shared/protocol";

declare global {
	interface Window {
		piDesktop: PiDesktopBridge;
		/** Injected by Electron in sandboxed renderers (webFrame access). */
		electron: { webFrame: { setZoomFactor(factor: number): void } };
	}
}

export {};
