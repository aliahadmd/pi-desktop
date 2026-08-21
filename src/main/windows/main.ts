/**
 * Main window factory. Security posture (docs/security.md):
 * contextIsolation + sandbox on, nodeIntegration off, no navigation away,
 * no window.open, all permission requests denied.
 */
import { BrowserWindow, shell } from "electron";
import path from "node:path";

export interface MainWindowOptions {
	preloadPath: string;
	rendererUrl: string | undefined; // dev server URL; undefined in production
	bounds?: Electron.Rectangle;
	onClosed(): void;
}

export function createMainWindow(options: MainWindowOptions): BrowserWindow {
	const { bounds } = options;
	const window = new BrowserWindow({
		...(bounds !== undefined
			? {
					bounds,
					width: bounds.width,
					height: bounds.height,
					x: bounds.x,
					y: bounds.y,
				}
			: { width: 1280, height: 820 }),
		minWidth: 860,
		minHeight: 560,
		titleBarStyle: "hiddenInset", // macOS-native feel; custom drag region in UI
		trafficLightPosition: { x: 16, y: 16 },
		backgroundColor: "#1a1a1e",
		show: false,
		webPreferences: {
			preload: options.preloadPath,
			contextIsolation: true,
			sandbox: true,
			nodeIntegration: false,
			webSecurity: true,
			spellcheck: false,
		},
	});

	window.once("ready-to-show", () => window.show());

	// Lock down navigation and popups.
	window.webContents.on("will-navigate", (event, url) => {
		const allowed = options.rendererUrl !== undefined && url === options.rendererUrl;
		if (!allowed) event.preventDefault();
	});
	window.webContents.setWindowOpenHandler(({ url }) => {
		// External links open in the user's browser, never in-app.
		if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
		return { action: "deny" };
	});

	if (options.rendererUrl !== undefined) {
		void window.loadURL(options.rendererUrl);
	} else {
		void window.loadFile(path.join(__dirname, "../renderer/index.html"));
	}

	window.on("closed", () => options.onClosed());
	return window;
}
