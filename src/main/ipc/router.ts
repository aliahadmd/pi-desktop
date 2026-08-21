/**
 * Typed IPC router for the main process.
 *
 * Handlers are registered per channel with the schema from shared/protocol.ts.
 * Incoming payloads are validated at the boundary before dispatch; failures
 * become structured `{ ok: false, error }` results — they never throw across
 * the wire.
 *
 * The dispatch core is pure (no electron imports) so it is unit-testable;
 * attach() binds it to ipcMain once.
 */
import { Parse } from "typebox/value";
import type { IpcError, IpcResult, RequestKey, RequestMap, ResponseMap } from "../../shared/protocol";
import { requestSchemaMap } from "../../shared/protocol";
import { err, ok } from "../../shared/protocol";

type Handler<K extends RequestKey> = (
	request: RequestMap[K]
) => Promise<ResponseMap[K]> | ResponseMap[K];

interface HandlerEntry {
	invoke(request: unknown): Promise<IpcResult<unknown>>;
}

export class IpcRouter {
	private readonly handlers = new Map<RequestKey, HandlerEntry>();

	handle<K extends RequestKey>(key: K, handler: Handler<K>): void {
		const schema = requestSchemaMap[key];
		this.handlers.set(key, {
			invoke: async (request: unknown) => {
				let parsed: RequestMap[K];
				try {
					parsed = Parse(schema, request) as RequestMap[K];
				} catch (error) {
					return err(
						"invalid_request",
						`payload rejected for "${String(key)}": ${describeParseError(error)}`
					);
				}
				try {
					return ok(await handler(parsed));
				} catch (error) {
					return err("internal_error", describeParseError(error));
				}
			},
		});
	}

	/** Pure dispatch — usable from tests without electron. */
	async dispatch(rawRequest: unknown): Promise<IpcResult<unknown>> {
		const key = readChannelName(rawRequest);
		if (key === null || !this.handlers.has(key)) {
			const code: IpcError["code"] =
				key === null ? "invalid_request" : "unknown_channel";
			return err(
				code,
				`no handler for request: ${truncate(JSON.stringify(rawRequest ?? null))}`
			);
		}
		return this.handlers.get(key)!.invoke(rawRequest);
	}
}

/** Returns the channel name if `type` is a non-empty string, else null. */
function readChannelName(request: unknown): RequestKey | null {
	if (typeof request !== "object" || request === null) return null;
	const type = (request as { type?: unknown }).type;
	if (typeof type !== "string") return null;
	return type as RequestKey;
}

function describeParseError(error: unknown): string {
	return error instanceof Error ? error.message.slice(0, 300) : String(error);
}

function truncate(text: string | null | undefined): string {
	if (text === null || text === undefined) return "(non-serializable payload)";
	return text.length > 200 ? `${text.slice(0, 200)}…` : text;
}
