/**
 * Preload: the ONLY bridge between sandboxed renderer and main.
 * Exposes exactly one object, `window.piDesktop`, with typed invoke/on plus
 * the terminal (pty) streaming surface. No electron or node APIs leak.
 */
import { contextBridge, ipcRenderer, webUtils } from "electron";

const IPC_INVOKE_CHANNEL = "pidesktop:invoke";
const IPC_EVENT_CHANNEL = "pidesktop:event";

const bridge = {
	invoke: (request: unknown) => ipcRenderer.invoke(IPC_INVOKE_CHANNEL, request),
	/** Absolute path of a dropped/pasted File. Browsers hide it; Electron exposes it. */
	filePath: (file: File): string => {
		try {
			return webUtils.getPathForFile(file);
		} catch {
			return "";
		}
	},
	on: (listener: (event: unknown) => void) => {
		const wrapped = (_event: unknown, payload: unknown): void => {
			listener(payload);
		};
		ipcRenderer.on(IPC_EVENT_CHANNEL, wrapped);
		return () => {
			ipcRenderer.removeListener(IPC_EVENT_CHANNEL, wrapped);
		};
	},
	/** Embedded terminal streams (chapter 7). Dedicated high-frequency channels. */
	pty: {
		create(req: { id: string; cwd: string; cols: number; rows: number }): void {
			ipcRenderer.send("pty:create", req);
		},
		write(id: string, data: string): void {
			ipcRenderer.send("pty:write", { id, data });
		},
		resize(id: string, cols: number, rows: number): void {
			ipcRenderer.send("pty:resize", { id, cols, rows });
		},
		kill(id: string): void {
			ipcRenderer.send("pty:kill", { id });
		},
		onData(id: string, listener: (data: string) => void): () => void {
			const wrapped = (_event: unknown, data: unknown): void => {
				listener(String(data));
			};
			ipcRenderer.on(`pty:data:${id}`, wrapped);
			return () => {
				ipcRenderer.removeListener(`pty:data:${id}`, wrapped);
			};
		},
	},
};

contextBridge.exposeInMainWorld("piDesktop", bridge);
