/**
 * Window-close session reattach (audit 6 H-1): sessions live in the main
 * process and outlive the window. Two guarantees keep that safe:
 *
 *  1. session.resume for a file already bound to a live backend returns the
 *     existing entry instead of spawning a second runtime — two backends would
 *     append to the same JSONL.
 *  2. session.list_open reports every open session in the
 *     SessionOpenedResponse shape, so a reopened/reloaded renderer can
 *     rehydrate its store without resuming anything.
 *
 * Backend factories are mocked: the guard/listing logic lives in PiService and
 * must be exercised without real SDK/RPC processes.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IPiBackend } from "../../src/main/pi/backend";
import type { RendererEventBus } from "../../src/main/ipc/events";
import { IpcRouter } from "../../src/main/ipc/router";

vi.mock("../../src/main/pi/sdk-backend", () => ({
	SdkPiBackend: { create: vi.fn() },
}));
vi.mock("../../src/main/pi/rpc-backend", () => ({
	RpcPiBackend: { create: vi.fn() },
}));

import { PiService } from "../../src/main/pi/service";
import { SdkPiBackend } from "../../src/main/pi/sdk-backend";

const fakeBus = { send: () => {} } as unknown as RendererEventBus;

beforeEach(() => {
	// Call history must not leak across tests (create is asserted as never/once).
	vi.clearAllMocks();
});

function stubBackend(sessionFile: string | undefined): IPiBackend {
	return {
		kind: "sdk" as const,
		start: async () => {},
		dispose: async () => {},
		getSessionFile: () => sessionFile,
		getState: async () => ({
			sessionId: "pi-stub",
			sessionFile,
			model: { provider: "openai", id: "gpt-5", name: "GPT-5" },
		}),
	} as unknown as IPiBackend;
}

/** Insert a live session directly into the registry (same pattern as session-cwd.test.ts). */
function insertSession(service: PiService, id: string, cwd: string, backend: IPiBackend, sessionFile?: string): void {
	(
		service as unknown as {
			sessions: Map<
				string,
				{ id: string; cwd: string; backend: IPiBackend; startedAt: number; sessionFile?: string }
			>;
		}
	).sessions.set(id, {
		id,
		cwd,
		backend,
		startedAt: Date.now(),
		...(sessionFile !== undefined ? { sessionFile } : {}),
	});
}

function routed(service: PiService): IpcRouter {
	const router = new IpcRouter();
	service.registerHandlers(router);
	return router;
}

describe("session.resume already-open guard (audit 6 H-1)", () => {
	it("reattaches to the entry tracked by its registry sessionFile", async () => {
		const service = new PiService(fakeBus);
		insertSession(service, "s1", "/tmp/project-a", stubBackend("/tmp/a.jsonl"), "/tmp/a.jsonl");
		const router = routed(service);

		const result = await router.dispatch({ type: "session.resume", sessionPath: "/tmp/a.jsonl" });

		expect(result.ok).toBe(true);
		if (result.ok) {
			const data = result.data as { sessionId: string; backend: string; cwd: string };
			expect(data.sessionId).toBe("s1");
			expect(data.backend).toBe("sdk");
			expect(data.cwd).toBe("/tmp/project-a");
		}
		// No second runtime was created for the same file.
		expect(service.openSessionCount).toBe(1);
		expect(SdkPiBackend.create).not.toHaveBeenCalled();
	});

	it("also matches the backend's live sessionFile when the registry field is unset", async () => {
		const service = new PiService(fakeBus);
		insertSession(service, "s1", "/tmp/project-a", stubBackend("/tmp/a.jsonl"));
		const router = routed(service);

		const result = await router.dispatch({ type: "session.resume", sessionPath: "/tmp/a.jsonl" });

		expect(result.ok).toBe(true);
		if (result.ok) expect((result.data as { sessionId: string }).sessionId).toBe("s1");
		expect(service.openSessionCount).toBe(1);
		expect(SdkPiBackend.create).not.toHaveBeenCalled();
	});

	it("starts a new backend for a session file that is not open", async () => {
		vi.mocked(SdkPiBackend.create).mockReturnValueOnce(stubBackend("/tmp/b.jsonl") as never);
		const service = new PiService(fakeBus);
		insertSession(service, "s1", "/tmp/project-a", stubBackend("/tmp/a.jsonl"), "/tmp/a.jsonl");
		const router = routed(service);

		const result = await router.dispatch({ type: "session.resume", sessionPath: "/tmp/b.jsonl" });

		expect(result.ok).toBe(true);
		if (result.ok) {
			const data = result.data as { sessionId: string };
			expect(data.sessionId).not.toBe("s1");
		}
		expect(service.openSessionCount).toBe(2);
		expect(SdkPiBackend.create).toHaveBeenCalledOnce();
	});
});

describe("session.list_open (audit 6 H-1)", () => {
	it("returns an empty list when nothing is open", async () => {
		const service = new PiService(fakeBus);
		const router = routed(service);

		const result = await router.dispatch({ type: "session.list_open" });

		expect(result.ok).toBe(true);
		if (result.ok) expect(result.data).toEqual({ sessions: [] });
	});

	it("reports open sessions in SessionOpenedResponse shape", async () => {
		const service = new PiService(fakeBus);
		insertSession(service, "s1", "/tmp/project-a", stubBackend("/tmp/a.jsonl"), "/tmp/a.jsonl");
		insertSession(service, "s2", "/tmp/project-b", stubBackend(undefined));
		const router = routed(service);

		const result = await router.dispatch({ type: "session.list_open" });

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const { sessions } = result.data as {
			sessions: Array<{
				sessionId: string;
				backend: string;
				cwd: string;
				sessionFile: string | undefined;
				model: { provider: string; id: string; name: string } | undefined;
			}>;
		};
		expect(sessions).toHaveLength(2);
		expect(sessions[0]).toEqual({
			sessionId: "s1",
			backend: "sdk",
			cwd: "/tmp/project-a",
			sessionFile: "/tmp/a.jsonl",
			model: { provider: "openai", id: "gpt-5", name: "GPT-5" },
		});
		expect(sessions[1]).toEqual({
			sessionId: "s2",
			backend: "sdk",
			cwd: "/tmp/project-b",
			sessionFile: undefined,
			model: { provider: "openai", id: "gpt-5", name: "GPT-5" },
		});
	});

	it("shrinks after a session closes", async () => {
		const service = new PiService(fakeBus);
		insertSession(service, "s1", "/tmp/project-a", stubBackend("/tmp/a.jsonl"), "/tmp/a.jsonl");
		const router = routed(service);

		await router.dispatch({ type: "session.close", sessionId: "s1" });
		const result = await router.dispatch({ type: "session.list_open" });

		expect(result.ok).toBe(true);
		if (result.ok) expect(result.data).toEqual({ sessions: [] });
	});
});
