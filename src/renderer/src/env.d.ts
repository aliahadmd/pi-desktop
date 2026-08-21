/// <reference types="vite/client" />
import type { PiDesktopBridge } from "../../shared/protocol";

declare global {
	interface Window {
		piDesktop: PiDesktopBridge;
	}
}

export {};
