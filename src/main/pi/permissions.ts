/**
 * Live permission-mode state (phase 5).
 *
 * The permission extension must read the current mode synchronously inside a
 * `tool_call` handler, and mode changes must take effect without re-registering
 * extensions. A plain mutable module store satisfies both; React-style
 * immutable state would not.
 *
 * Two levels:
 *  - session override: set by the composer picker, lives for the session
 *  - default: global fallback, persisted in StoreService ("permissionMode")
 *
 * Session overrides are deliberately NOT persisted — a fresh session starts
 * at the global default, matching how coding agents scope autonomy to a task.
 */
import type { PermissionMode } from "../../shared/pi";
import { DEFAULT_PERMISSION_MODE } from "../../shared/pi";

interface PermissionState {
	/** appSessionId -> effective override for that open session. */
	sessionModes: Map<string, PermissionMode>;
	defaultMode: PermissionMode;
}

// Survive dev-mode module reloads (electron-vite HMR) like other singletons.
const globalForPermissions = globalThis as {
	__piDesktopPermissionState?: PermissionState;
};

function state(): PermissionState {
	globalForPermissions.__piDesktopPermissionState ??= {
		sessionModes: new Map(),
		defaultMode: DEFAULT_PERMISSION_MODE,
	};
	return globalForPermissions.__piDesktopPermissionState;
}

type ModeListener = (appSessionId: string, mode: PermissionMode) => void;
const listeners = new Set<ModeListener>();

/** Effective mode for a session: its override, else the global default. */
export function getMode(appSessionId: string): PermissionMode {
	return state().sessionModes.get(appSessionId) ?? state().defaultMode;
}

/** Set an explicit per-session override. */
export function setMode(appSessionId: string, mode: PermissionMode): void {
	state().sessionModes.set(appSessionId, mode);
	for (const listener of listeners) listener(appSessionId, mode);
}

/** Drop the session override (session closed). Falls back to the default. */
export function clearSession(appSessionId: string): void {
	state().sessionModes.delete(appSessionId);
}

/** Alias used by PiService on session close — reads clearly at call sites. */
export const clearSessionPermissions = clearSession;

export function setDefaultMode(mode: PermissionMode): void {
	state().defaultMode = mode;
}

export function getDefaultMode(): PermissionMode {
	return state().defaultMode;
}

/** Subscribe to mode changes; returns an unsubscribe function. */
export function onModeChange(listener: ModeListener): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}
