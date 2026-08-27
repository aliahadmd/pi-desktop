/**
 * Typed IPC contract for Pi Desktop — the single source of truth shared by
 * main, preload, and renderer. No node/electron APIs may be imported here.
 *
 * Requests are discriminated unions: `{ type: "...", ...payload }`.
 * Every request schema is registered in `requestSchemaMap`; the response type
 * for each channel is declared in `ResponseMap`.
 */
import { Type, type Static } from "typebox";
import { piRequestSchemas, type PiResponseMap } from "./pi";

/** Object schema that rejects unknown keys (same pattern as pi-protocol). */
const StrictObject = <const T extends Parameters<typeof Type.Object>[0]>(
	properties: T
) => Type.Object(properties, { additionalProperties: false });

// ---------------------------------------------------------------------------
// Result envelope
// ---------------------------------------------------------------------------

export interface IpcError {
	code:
		| "unknown_channel"
		| "invalid_request"
		| "internal_error"
		| "not_implemented";
	message: string;
}

export type IpcResult<T> = { ok: true; data: T } | { ok: false; error: IpcError };

export function ok<T>(data: T): IpcResult<T> {
	return { ok: true, data };
}

export function err(code: IpcError["code"], message: string): IpcResult<never> {
	return { ok: false, error: { code, message } };
}

// ---------------------------------------------------------------------------
// Request schemas (grow per chapter)
// ---------------------------------------------------------------------------

export const pingRequestSchema = StrictObject({
	type: Type.Literal("ping"),
});

export type PingRequest = Static<typeof pingRequestSchema>;

export interface PingResponse {
	pong: string;
	mainVersion: string;
	electronVersion: string;
	timestamp: number;
}

export const logWriteRequestSchema = StrictObject({
	type: Type.Literal("log_write"),
	level: Type.Union([
		Type.Literal("debug"),
		Type.Literal("info"),
		Type.Literal("warn"),
		Type.Literal("error"),
	]),
	args: Type.Array(Type.String()),
});

export type LogWriteRequest = Static<typeof logWriteRequestSchema>;

export const pickDirectoryRequestSchema = StrictObject({
	type: Type.Literal("app_pick_directory"),
});

export interface PickDirectoryResponse {
	path: string | null;
}

/** Channel name → schema. Validation happens at the IPC boundary in main. */
export const requestSchemaMap = {
	ping: pingRequestSchema,
	log_write: logWriteRequestSchema,
	app_pick_directory: pickDirectoryRequestSchema,
	...piRequestSchemas,
} as const;

export type RequestKey = keyof typeof requestSchemaMap;
export type RequestMap = { [K in RequestKey]: Static<(typeof requestSchemaMap)[K]> };
export type IpcRequest = RequestMap[RequestKey];

/** Channel name → response payload type. */
export interface ResponseMap extends PiResponseMap {
	ping: PingResponse;
	log_write: null;
	app_pick_directory: PickDirectoryResponse;
}

/** The generic invoke signature exposed to the renderer. */
export type Invoke = <K extends RequestKey>(
	request: Extract<IpcRequest, { type: K }>
) => Promise<IpcResult<ResponseMap[K]>>;

// ---------------------------------------------------------------------------
// Main → renderer events
// ---------------------------------------------------------------------------

/** Envelope routing pi session events to the tab/window that owns them. */
export interface PiSessionEventEnvelope {
	type: "pi_event";
	sessionId: string;
	event: import("./pi").PiEvent;
}

export interface SidecarStatusEvent {
	type: "sidecar_status";
	status: "starting" | "healthy" | "degraded" | "stopped";
}

export interface AuthPromptEvent {
	type: "auth_prompt";
	loginId: string;
	providerId: string;
	prompt: import("./pi").JsonValue;
}

export interface AuthNotifyEvent {
	type: "auth_notify";
	loginId: string;
	providerId: string;
	event: import("./pi").JsonValue;
}

export type IpcEvent =
	| PiSessionEventEnvelope
	| SidecarStatusEvent
	| AuthPromptEvent
	| AuthNotifyEvent;

// ---------------------------------------------------------------------------
// Preload bridge surface (implemented in src/preload/index.ts)
// ---------------------------------------------------------------------------

export interface PiDesktopBridge {
	filePath(file: File): string;
	invoke: Invoke;
	/** Subscribe to main→renderer events. Returns an unsubscribe function. */
	on(listener: (event: IpcEvent) => void): () => void;
	pty: {
		create(req: { id: string; cwd: string; cols: number; rows: number }): void;
		write(id: string, data: string): void;
		resize(id: string, cols: number, rows: number): void;
		kill(id: string): void;
		onData(id: string, listener: (data: string) => void): () => void;
	};
}
