import { describe, expect, it } from "vitest";
import { IpcRouter } from "../../src/main/ipc/router";

function makeRouter(): IpcRouter {
	const router = new IpcRouter();
	router.handle("ping", () => ({
		pong: "pong",
		mainVersion: "0.0.0-test",
		electronVersion: "38.0.0",
		timestamp: 123,
	}));
	router.handle("log_write", (request) => {
		if (request.args[0] === "boom") throw new Error("handler exploded");
		return null;
	});
	return router;
}

describe("IpcRouter.dispatch", () => {
	it("routes a valid request to its handler and wraps the result", async () => {
		const result = await makeRouter().dispatch({ type: "ping" });
		expect(result).toEqual({
			ok: true,
			data: {
				pong: "pong",
				mainVersion: "0.0.0-test",
				electronVersion: "38.0.0",
				timestamp: 123,
			},
		});
	});

	it("rejects payloads that fail schema validation with invalid_request", async () => {
		const result = await makeRouter().dispatch({ type: "log_write", level: "nope" });
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.code).toBe("invalid_request");
	});

	it("rejects non-object payloads with invalid_request", async () => {
		for (const bad of [null, undefined, 42, "ping", [], { level: "info" }]) {
			const result = await makeRouter().dispatch(bad);
			expect(result.ok).toBe(false);
			if (!result.ok) expect(result.error.code).toBe("invalid_request");
		}
	});

	it("returns unknown_channel for well-formed but unregistered types", async () => {
		const result = await makeRouter().dispatch({ type: "session.prompt" });
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.code).toBe("unknown_channel");
	});

	it("converts handler exceptions into internal_error results", async () => {
		const result = await makeRouter().dispatch({
			type: "log_write",
			level: "info",
			args: ["boom"],
		});
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.code).toBe("internal_error");
			expect(result.error.message).toContain("handler exploded");
		}
	});

	it("accepts extra properties only when the schema allows them", async () => {
		const strict = await makeRouter().dispatch({ type: "ping", extra: true });
		// typebox default object schema rejects unknown keys
		expect(strict.ok).toBe(false);
	});
});
