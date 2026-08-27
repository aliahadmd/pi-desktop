#!/usr/bin/env node
/**
 * Fake `pi --mode rpc` responder for backend tests. Speaks the RPC protocol:
 * reads JSONL commands from stdin, emits events + responses on stdout.
 * Scenarios are selected via the FAKE_PI_SCENE env var.
 */
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
	buffer += chunk;
	for (;;) {
		const idx = buffer.indexOf("\n");
		if (idx === -1) break;
		const line = buffer.slice(0, idx);
		buffer = buffer.slice(idx + 1);
		if (line.trim().length > 0) handle(JSON.parse(line));
	}
});

function send(obj) {
	process.stdout.write(JSON.stringify(obj) + "\n");
}

/**
 * Write one JSON line split in two chunks, the boundary landing in the middle
 * of a multi-byte UTF-8 sequence (audit 6 M-6 regression fixture).
 */
function sendSplit(obj) {
	const buf = Buffer.from(JSON.stringify(obj) + "\n", "utf8");
	const marker = Buffer.from("🚀", "utf8");
	const idx = buf.indexOf(marker);
	const split = idx === -1 ? Math.floor(buf.length / 2) : idx + 2;
	process.stdout.write(buf.subarray(0, split));
	setTimeout(() => process.stdout.write(buf.subarray(split)), 10);
}

function reply(cmd, obj) {
	send({ ...obj, ...(cmd.id !== undefined ? { id: cmd.id } : {}) });
}

function handle(cmd) {
	const scene = process.env.FAKE_PI_SCENE ?? "basic";
	switch (cmd.type) {
		case "prompt": {
			send({ type: "agent_start" });
			send({ type: "message_start", message: { role: "assistant", content: [] } });
			// Split text delta across chunk boundary to exercise framing.
			const text = `echo:${cmd.message}`;
			const half = Math.floor(text.length / 2);
			send({
				type: "message_update",
				usage: { input: 1, output: 1, totalTokens: 2 },
				assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: text.slice(0, half) },
			});
			send({
				type: "message_update",
				assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: text.slice(half) },
			});
			send({
				type: "message_end",
				message: { role: "assistant", content: [{ type: "text", text }] },
			});
			send({ type: "agent_end", willRetry: false });
			send({ type: "agent_settled" });
			reply(cmd, { type: "response", command: "prompt", success: true });
			break;
		}
		case "get_state":
			reply(cmd, {
				type: "response",
				command: "get_state",
				success: true,
				data: {
					sessionId: "fake-session",
					sessionFile: "/tmp/fake.jsonl",
					model: { provider: "fake", id: "fake-model" },
					thinkingLevel: "medium",
					isStreaming: false,
					isCompacting: false,
					autoCompactionEnabled: true,
					messageCount: 2,
					pendingMessageCount: 0,
				},
			});
			break;
		case "set_model":
			reply(cmd, { type: "response", command: "set_model", success: false, error: "unknown model: x/y" });
			break;
		case "extension_ui_response":
			// Echo the user's answer back as an observable event.
			send({
				type: "session_info_changed",
				name: "answer:" + JSON.stringify({ confirmed: cmd.confirmed, cancelled: cmd.cancelled }),
			});
			break;
		case "get_commands":
			reply(cmd, {
				type: "response",
				command: "get_commands",
				success: true,
				data: { commands: [{ name: "greet", source: "extension" }] },
			});
			break;
		case "abort":
			send({ type: "agent_settled" });
			reply(cmd, { type: "response", command: "abort", success: true });
			break;
		case "fail":
			reply(cmd, { type: "response", command: "fail", success: false, error: "boom" });
			break;
		case "dialog":
			// Extension asks the user to confirm; echo the answer back as an event.
			send({
				type: "extension_ui_request",
				id: "ui-1",
				method: "confirm",
				title: "Allow?",
				message: "Proceed with the thing?",
			});
			reply(cmd, { type: "response", command: "dialog", success: true });
			break;
		case "dialog-bad-timeout":
			// Garbage timeout field — the client must not ship NaN to the renderer.
			send({
				type: "extension_ui_request",
				id: "ui-bad",
				method: "select",
				title: "Pick one",
				options: ["a", "b"],
				timeout: "not-a-number",
			});
			reply(cmd, { type: "response", command: "dialog-bad-timeout", success: true });
			break;
		case "utf8": {
			// Multi-byte text split mid-codepoint across stdout chunks (M-6).
			// The second split line is delayed so the two don't interleave.
			const text = "héllo — 世界 🚀";
			sendSplit({
				type: "message_update",
				usage: { input: 1, output: 1, totalTokens: 2 },
				assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: text },
			});
			setTimeout(() => {
				sendSplit({ type: "response", command: "utf8", success: true, id: cmd.id, data: { text } });
			}, 30);
			break;
		}
		case "get_available_models":
			reply(cmd, {
				type: "response",
				command: "get_available_models",
				success: true,
				data: {
					models: [
						{
							provider: "fake",
							id: "fake-pro",
							name: "Fake Pro",
							contextWindow: 200000,
							maxTokens: 8192,
							reasoning: true,
							input: ["text", "image"],
						},
						// Sparse entry: only the fields the old code knew about.
						{ provider: "fake", id: "fake-mini", contextWindow: 64000, reasoning: false },
					],
				},
			});
			break;
		case "get_entries":
			if (cmd.since === "unknown-cursor") {
				reply(cmd, {
					type: "response",
					command: "get_entries",
					success: false,
					error: `Entry not found: ${cmd.since}`,
				});
			} else {
				reply(cmd, {
					type: "response",
					command: "get_entries",
					success: true,
					data: { entries: [{ id: "e1" }, { id: "e2" }], leafId: "e2" },
				});
			}
			break;
		case "hang":
			// Never replies (timeout tests); in scene "exit-on-hang" the process
			// dies shortly after instead (M-7 pending-rejection tests).
			if (process.env.FAKE_PI_SCENE === "exit-on-hang") {
				setTimeout(() => process.exit(1), 50);
			}
			break;
		default:
			// Unknown command → success with no data (keeps the protocol moving).
			reply(cmd, { type: "response", command: String(cmd.type), success: true });
	}
	if (scene === "exit-after-first" && cmd.type === "prompt") {
		// simulate a crash after answering
		setTimeout(() => process.exit(1), 50);
	}
}
