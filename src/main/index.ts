/**
 * App entry point: lifecycle, single-instance lock, security handlers,
 * service wiring, and IPC handler registration.
 */
import {
	BrowserWindow,
	Notification,
	Tray,
	app,
	dialog,
	ipcMain,
	Menu,
	nativeImage,
	session,
	shell,
} from "electron";
import path from "node:path";
import { RendererEventBus } from "./ipc/events";
import type { JsonValue } from "../shared/pi";
import { IpcRouter } from "./ipc/router";
import { AuthService } from "./pi/auth";
import { PiService } from "./pi/service";
import { SidecarManager, type SearchHit } from "./sidecar/manager";
import { StoreService } from "./store/service";
import { FileBridge } from "./fs-bridge";
import * as gitService from "./git-service";
import { createDesktopTools } from "./pi/desktop-tools";
import { PtyService } from "./pty-service";
import { createLogger, type Logger } from "./services/logging";
import { setupAutoUpdater } from "./updater";
import { ensureAppPaths, pruneOldLogs, resolveAppPaths } from "./services/paths";
import { createMainWindow } from "./windows/main";

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
	app.quit();
}

// Deterministic userData path: ~/Library/Application Support/PiDesktop/
app.setName("Pi Desktop");

// OAuth callback deep link (chapter 6). Provider flows that use manual code
// paste don't need it, but registering keeps the URL scheme stable.
if (process.defaultApp === undefined) {
	app.setAsDefaultProtocolClient("pidesktop");
} else {
	app.setAsDefaultProtocolClient("pidesktop", process.execPath, [
		path.resolve(process.argv[1] ?? ""),
	]);
}

app.on("open-url", (event, url) => {
	event.preventDefault();
	// OAuth providers using manual code paste do not need this; logged for
	// providers that redirect to pidesktop:// until a callback server is wired.
	logger?.debug("main", `oauth callback received: ${url.slice(0, 120)}`);
});

let logger: Logger | undefined;
let piService: PiService | undefined;
let storeService: StoreService | undefined;
let sidecar: SidecarManager | undefined;
let authService: AuthService | undefined;
let ptyService: PtyService | undefined;
let tray: Tray | undefined;

app.on("second-instance", () => {
	const [first] = BrowserWindow.getAllWindows();
	first?.focus();
});

app.whenReady()
	.then(async () => {
		hardenSession();
		logger = bootstrapServices();

		const bus = new RendererEventBus();
		const router = registerHandlers();

		piService = new PiService(bus);
		piService.registerHandlers(router);

		storeService = new StoreService(app.getPath("userData"), (level, message) =>
			logger?.[level]("main", message)
		);
		storeService.start();
		storeService.attachPiService(piService);
		storeService.registerHandlers(router);
		storeService.startIndexer();

		authService = new AuthService({
			bus,
			getStored: (key) => storeService?.getSettingRaw(key),
			setStored: (key, value) => storeService?.setSettingRaw(key, value),
			log: (level, message) => logger?.[level]("main", message),
			onScopedModelsChanged: (models) => piService?.setScopedModels(models),
		});
		await authService.start();
		piService.setSharedRuntime(authService.getRuntime());
		authService.registerHandlers(router);
		{
			const stored = storeService.getSettingRaw("scopedModels");
			if (Array.isArray(stored)) {
				piService.setScopedModels(
					stored as Array<{ provider: string; modelId: string; thinkingLevel?: string }>
				);
			}
		}

		const bridge = new FileBridge();
		const shellMod = await import("electron").then((m) => m.shell);
		piService.setDesktopTools(
			createDesktopTools({
				notify: (title, body) => {
					const n = new Notification({ title, body });
					n.on("click", () => focusMainWindow());
					n.show();
				},
				writeClipboard: (text) => {
					void import("electron").then(({ clipboard }) => clipboard.writeText(text));
				},
				assertRealScoped: (p) => bridge.assertRealScoped(p),
				showItemInFolder: (p) => void shellMod.showItemInFolder(p),
			})
		);
		router.handle("fs.list", async (req) => {
			return { entries: await bridge.list(req.dirPath) };
		});
		router.handle("fs.read", async (req) => {
			return await bridge.readFile(req.filePath);
		});
		router.handle("workspace.roots", () => ({ roots: bridge.getRoots() }));
		router.handle("git.context", async (req) => {
			const ctx = await gitService.context(req.root);
			return ctx.repo ? (ctx as unknown as import("../shared/pi").JsonValue) : null;
		});
		router.handle("workspace.reveal", async (req) => {
			const scoped = await bridge.assertRealScoped(req.path);
			shell.showItemInFolder(scoped);
			return null;
		});
		router.handle("workspace.open_in_editor", async (req) => {
			const scoped = await bridge.assertRealScoped(req.path);
			const line = req.line;
			try {
				// Prefer VS Code goto-line when the CLI exists; fall back to default app.
				const { spawn } = await import("node:child_process");
				const child = spawn("code", ["--goto", `${scoped}${line !== undefined ? `:${line}` : ""}`], {
					stdio: "ignore",
				});
				await new Promise<void>((resolve) => {
					child.on("error", () => resolve());
					child.on("exit", (code) => {
						if (code !== 0) void shell.openPath(scoped);
						resolve();
					});
					setTimeout(() => resolve(), 3000);
				});
			} catch {
				await shell.openPath(scoped);
			}
			return null;
		});

		// Resource text reader for skills/prompt templates (agent dir + project roots).
		router.handle("resources.read_text", async (req) => {
			// SECURITY: only markdown resource files are readable here. Never
			// allow auth.json / models-store.json / arbitrary agent-dir files.
			const resolved = path.resolve(req.path);
			if (!resolved.endsWith(".md")) {
				throw new Error(`only .md resources are readable: ${req.path}`);
			}
			const realTarget = await (async () => {
				try {
					return await (await import("node:fs/promises")).realpath(resolved);
				} catch {
					throw new Error(`resource not accessible: ${req.path}`);
				}
			})();
			const agentDirReal = await (async () => {
				const agentDir = path.join(app.getPath("home"), ".pi/agent");
				try {
					return await (await import("node:fs/promises")).realpath(agentDir);
				} catch {
					return agentDir;
				}
			})();
			const inAgentSkillsOrPrompts =
				realTarget.startsWith(path.join(agentDirReal, "skills") + path.sep) ||
				realTarget.startsWith(path.join(agentDirReal, "prompts") + path.sep);
			if (!inAgentSkillsOrPrompts) {
				// Fall back to project-root scoping (realpath-aware).
				await bridge.assertRealScoped(realTarget);
			}
			const { readFile } = await import("node:fs/promises");
			const content = await readFile(realTarget, "utf8");
			return { content: content.slice(0, 200_000) };
		});

		// Session observers: root registration, tray count, completion notifications.
		piService.addHooks({
			onSessionOpened: (info) => {
				const roots = bridge.getRoots();
				if (!roots.includes(info.cwd)) {
					bridge.setRoots([...roots, info.cwd]);
				}
				updateTray();
			},
			onSessionClosed: () => updateTray(),
			onSessionEvent: (appSessionId, event) => {
				if (
					event.type === "agent_settled" &&
					BrowserWindow.getAllWindows().every((w) => !w.isFocused())
				) {
					showCompletionNotification(piService?.getSessionCwd(appSessionId) ?? "");
				}
			},
		});

		ptyService = new PtyService({
			webContents: () => BrowserWindow.getAllWindows()[0]?.webContents ?? null,
			resolveScoped: (cwd) => bridge.resolveScoped(cwd),
			log: (level, message) => logger?.[level]("main", message),
		});
		ptyService.register();

		sidecar = new SidecarManager({
			appSupportDir: app.getPath("userData"),
			agentDir: path.join(app.getPath("home"), ".pi/agent"),
			onStatus: (status) => bus.send({ type: "sidecar_status", status }),
			log: (level, message) => logger?.[level]("main", message),
		});
		void sidecar.start();

		router.handle("sidecar.rebuild", async () => {
			const data = await sidecar?.post<JsonValue>("/index/rebuild");
			return data ?? null;
		});
		router.handle("sidecar.status", () => ({
			status: sidecar?.currentStatus ?? "stopped",
		}));
		router.handle("sidecar.search", async (req) => {
			const hits: SearchHit[] | null =
				(await sidecar?.search(req.query, req.limit ?? 50)) ?? null;
			return hits === null ? null : { hits };
		});
		router.handle("sidecar.usage", async (req) => {
			const data = await sidecar?.get<JsonValue>(`/analytics/usage`, {
				days: String(req.days ?? 30),
			});
			return data ?? null;
		});
		router.handle("sidecar.top", async (req) => {
			const data = await sidecar?.get<JsonValue>(`/analytics/top-sessions`, {
				by: req.by ?? "cost",
				limit: String(req.limit ?? 10),
			});
			return data ?? null;
		});

		setupApplicationMenu();

		ipcMain.handle("pidesktop:invoke", (_event, rawRequest: unknown) =>
			router.dispatch(rawRequest)
		);

		const savedBounds = storeService.getWindowState<Electron.Rectangle | undefined>(undefined);
		const clampedBounds =
			savedBounds !== undefined ? clampBoundsToScreen(savedBounds) : undefined;
		const window = createMainWindow({
			preloadPath: path.join(__dirname, "../preload/index.js"),
			rendererUrl: process.env.ELECTRON_RENDERER_URL,
			...(clampedBounds !== undefined ? { bounds: clampedBounds } : {}),
			onClosed: () => {
				bus.setWindow(null);
			},
		});
		bus.setWindow(window);
		window.on("close", () => {
			storeService?.setWindowState(window.getBounds());
		});

		createTray();
		setupAutoUpdater(logger);
		logger.info("main", "app ready", { version: app.getVersion() });
	})
	.catch((error: unknown) => {
		logger?.error("main", `startup failed: ${String(error)}`);
	});

app.on("window-all-closed", () => {
	// macOS convention: stay alive (tray active). Quit explicitly via Cmd+Q.
});

app.on("before-quit", (event) => {
	if (piService === undefined && storeService === undefined && ptyService === undefined) return;
	// Give backends a moment to terminate subprocesses cleanly.
	event.preventDefault();
	const closingPi = piService;
	const closingStore = storeService;
	const closingSidecar = sidecar;
	const closingAuth = authService;
	const closingPty = ptyService;
	piService = undefined;
	storeService = undefined;
	sidecar = undefined;
	authService = undefined;
	ptyService = undefined;
	closingPty?.disposeAll();
	void closingPi?.disposeAll()
		.catch(() => {})
		.finally(() => {
			closingStore?.stop();
			void Promise.all([
				closingSidecar?.stop().catch(() => {}),
				closingAuth?.stop().catch(() => {}),
			]).finally(() => app.quit());
		});
});

app.on("activate", () => {
	if (BrowserWindow.getAllWindows().length === 0 && app.isReady()) {
		createMainWindow({
			preloadPath: path.join(__dirname, "../preload/index.js"),
			rendererUrl: process.env.ELECTRON_RENDERER_URL,
			onClosed: () => {},
		});
	}
});

/** Clamp restored window bounds into the nearest display's work area. */
function clampBoundsToScreen(bounds: Electron.Rectangle): Electron.Rectangle {
	const { screen } = require("electron") as typeof import("electron");
	const workArea = screen.getDisplayMatching(bounds).workArea;
	const width = Math.min(bounds.width, workArea.width);
	const height = Math.min(bounds.height, workArea.height);
	const x = Math.min(Math.max(bounds.x, workArea.x), workArea.x + workArea.width - width);
	const y = Math.min(Math.max(bounds.y, workArea.y), workArea.y + workArea.height - height);
	return { x, y, width, height };
}

/** Deny every permission request and block permission checks by default. */
function hardenSession(): void {
	session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => {
		callback(false);
	});
	session.defaultSession.setPermissionCheckHandler(() => false);
}

function bootstrapServices(): Logger {
	const paths = resolveAppPaths(app.getPath("userData"));
	ensureAppPaths(paths);
	pruneOldLogs(paths.logs);
	return createLogger(paths.logs);
}

function registerHandlers(): IpcRouter {
	const router = new IpcRouter();

	router.handle("ping", () => {
		logger?.debug("main", "ping received");
		return {
			pong: "pong",
			mainVersion: app.getVersion(),
			electronVersion: process.versions.electron ?? "unknown",
			timestamp: Date.now(),
		};
	});

	// Renderer console forwarding → file log.
	router.handle("log_write", (request) => {
		const { level, args } = request;
		logger?.[level]("renderer", ...args);
		return null;
	});

	// Native folder picker for new sessions. Tests may pre-set the choice.
	router.handle("app_pick_directory", async () => {
		if (process.env.PI_DESKTOP_TEST_PICK_DIR !== undefined) {
			return { path: process.env.PI_DESKTOP_TEST_PICK_DIR };
		}
		const result = await dialog.showOpenDialog({
			properties: ["openDirectory", "createDirectory"],
			message: "Choose a project folder for the pi session",
		});
		const [first] = result.filePaths;
		return { path: first ?? null };
	});

	return router;
}

// ---------------------------------------------------------------------------
// Tray, menu, notifications (chapter 7)
// ---------------------------------------------------------------------------

function createTray(): void {
	// 16x16 monochrome circle as template image (adapts to menu bar theme).
	const icon = nativeImage.createFromDataURL(
		"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAKklEQVQ4y2NgoBAwYv7/z8DAwMDAwMDAxMDIyMDIyMDIyMAkF1nNAABKZQHBNiMq6gAAAABJRU5ErkJggg=="
	);
	icon.setTemplateImage(true);
	try {
		tray = new Tray(icon);
		updateTray();
	} catch (error) {
		logger?.warn("main", `tray creation failed: ${String(error)}`);
	}
}

function updateTray(): void {
	if (tray === undefined) return;
	const count = piService?.openSessionCount ?? 0;
	tray.setToolTip(`Pi Desktop — ${count} open session${count === 1 ? "" : "s"}`);
	tray.setContextMenu(
		Menu.buildFromTemplate([
			{
				label: `Open Pi Desktop (${count} session${count === 1 ? "" : "s"})`,
				click: () => focusMainWindow(),
			},
			{ type: "separator" },
			{ label: "Quit", click: () => app.quit() },
		])
	);
}

function focusMainWindow(): void {
	const win = BrowserWindow.getAllWindows()[0];
	if (win !== undefined) {
		win.show();
		win.focus();
	}
}

function showCompletionNotification(cwd: string): void {
	const notification = new Notification({
		title: "Pi agent finished",
		body: cwd.length > 0 ? cwd : "Your session completed.",
		silent: false,
	});
	notification.on("click", () => focusMainWindow());
	notification.show();
}

function setupApplicationMenu(): void {
	const menu = Menu.buildFromTemplate([
		{
			label: app.name,
			submenu: [
				{ role: "about" },
				{ type: "separator" },
				{ role: "hide" },
				{ role: "hideOthers" },
				{ role: "unhide" },
				{ type: "separator" },
				{ role: "quit" },
			],
		},
		{
			label: "Edit",
			submenu: [
				{ role: "undo" },
				{ role: "redo" },
				{ type: "separator" },
				{ role: "cut" },
				{ role: "copy" },
				{ role: "paste" },
				{ role: "selectAll" },
			],
		},
		{
			label: "View",
			submenu: [
				{ role: "reload" },
				{ role: "toggleDevTools" },
				{ type: "separator" },
				{ role: "resetZoom" },
				{ role: "zoomIn" },
				{ role: "zoomOut" },
				{ type: "separator" },
				{ role: "togglefullscreen" },
			],
		},
		{ label: "Window", submenu: [{ role: "minimize" }, { role: "zoom" }, { role: "front" }] },
		{
			label: "Help",
			role: "help",
			submenu: [
				{
					label: "Pi Documentation",
					click: () => void import("electron").then(({ shell }) => shell.openExternal("https://pi.dev/docs/latest")),
				},
			],
		},
	]);
	Menu.setApplicationMenu(menu);
}
