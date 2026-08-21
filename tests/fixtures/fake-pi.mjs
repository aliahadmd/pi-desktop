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
		default:
			// Unknown command → success with no data (keeps the protocol moving).
			reply(cmd, { type: "response", command: String(cmd.type), success: true });
	}
	if (scene === "exit-after-first" && cmd.type === "prompt") {
		// simulate a crash after answering
		setTimeout(() => process.exit(1), 50);
	}
}
