import { describe, expect, it } from "vitest";
import { JsonlLineReader } from "../../src/main/pi/jsonl-reader";

describe("JsonlLineReader (pi RPC framing rules)", () => {
	it("splits on LF only", () => {
		const reader = new JsonlLineReader();
		expect(reader.push('{"a":1}\n{"b":2}\n')).toEqual(['{"a":1}', '{"b":2}']);
	});

	it("does NOT treat U+2028/U+2029 as newlines (readline violation)", () => {
		const reader = new JsonlLineReader();
		const line = JSON.stringify({ text: "line sep" });
		expect(reader.push(`${line}\n`)).toEqual([line]);
	});

	it("buffers partial chunks until the newline arrives", () => {
		const reader = new JsonlLineReader();
		expect(reader.push('{"a"')).toEqual([]);
		expect(reader.push(":1}")).toEqual([]);
		expect(reader.push("\n")).toEqual(['{"a":1}']);
	});

	it("strips a trailing \\r before \\n", () => {
		const reader = new JsonlLineReader();
		expect(reader.push('{"a":1}\r\n')).toEqual(['{"a":1}']);
	});

	it("flushes trailing data without a final newline", () => {
		const reader = new JsonlLineReader();
		expect(reader.push('{"a":1}\n{"b"')).toEqual(['{"a":1}']);
		expect(reader.flush()).toEqual('{"b"');
		expect(reader.flush()).toBeUndefined();
	});

	it("handles multibyte-safe content split across pushes (string level)", () => {
		const reader = new JsonlLineReader();
		const emoji = JSON.stringify({ t: "👍" });
		const first = emoji.slice(0, 10);
		expect(reader.push(first)).toEqual([]);
		expect(reader.push(`${emoji.slice(10)}\n`)).toEqual([emoji]);
	});
});
