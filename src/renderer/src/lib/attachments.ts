/**
 * Composer attachment helpers (audit 6 M-19): a size cap for image payloads
 * and a chunked base64 encoder. Pure — no React/Electron — so unit tests can
 * run them in node.
 */

/**
 * Decoded-byte cap for image attachments. Above this, the base64 payload
 * (~1.33×) makes an oversized session.prompt IPC call and providers reject
 * the image anyway, so the composer refuses with a notice instead of
 * encoding 20 M iterations byte-by-byte.
 */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

export function isImageAccepted(size: number): boolean {
	return size <= MAX_IMAGE_BYTES;
}

/**
 * Uint8Array → base64 without the per-byte `String.fromCharCode` loop.
 * 32k-arg chunks stay well under the engine's call argument limit.
 */
export function bytesToBase64(bytes: Uint8Array): string {
	const CHUNK = 0x8000;
	let binary = "";
	for (let i = 0; i < bytes.length; i += CHUNK) {
		binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
	}
	return btoa(binary);
}
