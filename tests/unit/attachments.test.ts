/**
 * Composer attachment helpers (audit 6 M-19): oversized images are refused
 * before the base64 encode, and the chunked encoder must agree with the
 * platform base64 across its 32k chunk boundary.
 */
import { describe, expect, it } from "vitest";
import {
	bytesToBase64,
	isImageAccepted,
	MAX_IMAGE_BYTES,
} from "../../src/renderer/src/lib/attachments";

describe("image size cap (audit 6 M-19)", () => {
	it("accepts at the cap and rejects above it", () => {
		expect(isImageAccepted(0)).toBe(true);
		expect(isImageAccepted(MAX_IMAGE_BYTES)).toBe(true);
		expect(isImageAccepted(MAX_IMAGE_BYTES + 1)).toBe(false);
	});
});

describe("bytesToBase64", () => {
	it("round-trips across the chunk boundary", () => {
		for (const size of [0, 1, 0x7fff, 0x8000, 0x8001, 0x8000 * 3 + 7]) {
			const bytes = new Uint8Array(size);
			for (let i = 0; i < size; i++) bytes[i] = (i * 31 + 7) & 0xff;
			expect(bytesToBase64(bytes)).toBe(Buffer.from(bytes).toString("base64"));
		}
	});
});
