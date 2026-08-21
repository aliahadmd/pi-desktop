/**
 * Strict JSONL line reader for the pi RPC protocol.
 *
 * Protocol rules (packages/coding-agent/docs/rpc.md):
 *  - Records are delimited by LF (\n) ONLY — never split on U+2028/U+2029
 *    (this is why Node's readline must not be used).
 *  - A trailing \r before \n is tolerated and stripped.
 *  - Bytes split across chunk boundaries must be buffered until complete.
 */

export class JsonlLineReader {
	private buffer = "";

	/** Feed a decoded chunk; returns all complete lines contained in it. */
	push(chunk: string): string[] {
		this.buffer += chunk;
		const lines: string[] = [];
		for (;;) {
			const idx = this.buffer.indexOf("\n");
			if (idx === -1) break;
			let line = this.buffer.slice(0, idx);
			this.buffer = this.buffer.slice(idx + 1);
			if (line.endsWith("\r")) line = line.slice(0, -1);
			lines.push(line);
		}
		return lines;
	}

	/** Flush any trailing data without a final newline (e.g. stream end). */
	flush(): string | undefined {
		if (this.buffer.length === 0) return undefined;
		const rest = this.buffer;
		this.buffer = "";
		return rest.endsWith("\r") ? rest.slice(0, -1) : rest;
	}
}
