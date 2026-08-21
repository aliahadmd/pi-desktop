/**
 * Main → renderer event fan-out. Wraps webContents.send behind the shared
 * IpcEvent union so producers never touch electron directly. Backpressure /
 * delta coalescing lands in chapter 2 with the pi event stream.
 */
import type { BrowserWindow } from "electron";
import type { IpcEvent } from "../../shared/protocol";

export const IPC_EVENT_CHANNEL = "pidesktop:event";

export class RendererEventBus {
	private window: BrowserWindow | null = null;

	setWindow(window: BrowserWindow | null): void {
		this.window = window;
	}

	send(event: IpcEvent): void {
		const target = this.window;
		if (target === null || target.isDestroyed()) return;
		target.webContents.send(IPC_EVENT_CHANNEL, event);
	}
}
