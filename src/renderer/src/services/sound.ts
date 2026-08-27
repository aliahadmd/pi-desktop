/**
 * Sound service (chapter 23): subtle audio feedback for key events.
 * Uses Web Audio API with programmatically generated tones — no audio
 * assets needed, works in packaged builds without file resolution issues.
 */
let audioContext: AudioContext | null = null;

function getCtx(): AudioContext | null {
	try {
		if (audioContext === null) {
			audioContext = new AudioContext();
		}
		if (audioContext.state === "suspended") {
			// resume() can reject (e.g. no audio device); never an unhandled rejection.
			void audioContext.resume().catch(() => {});
		}
		return audioContext;
	} catch {
		return null;
	}
}

function playTone(
	frequency: number,
	durationMs: number,
	volume: number,
	delayMs = 0,
): void {
	const ctx = getCtx();
	if (ctx === null) return;
	const osc = ctx.createOscillator();
	const gain = ctx.createGain();
	osc.type = "sine";
	osc.frequency.value = frequency;
	gain.gain.setValueAtTime(volume, ctx.currentTime + delayMs / 1000);
	gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + delayMs / 1000 + durationMs / 1000);
	osc.connect(gain);
	gain.connect(ctx.destination);
	osc.start(ctx.currentTime + delayMs / 1000);
	osc.stop(ctx.currentTime + delayMs / 1000 + durationMs / 1000);
}

export type SoundEvent = "complete" | "error" | "sent" | "notification";

export function playSound(event: SoundEvent, volume: number = 0.3): void {
	if (volume <= 0) return;
	switch (event) {
		case "complete":
			playTone(523.25, 150, volume); // C5
			playTone(783.99, 200, volume, 120); // G5
			break;
		case "notification":
			playTone(659.25, 100, volume); // E5
			playTone(523.25, 120, volume, 80); // C5
			break;
		case "error":
			playTone(220, 250, volume * 1.2); // A3 low buzz
			break;
		case "sent":
			playTone(880, 60, volume * 0.5); // A5 short tick
			break;
	}
}

/** Play a sound unless the user disabled sound effects in settings. */
export function playSoundIfEnabled(event: SoundEvent): void {
	void window.piDesktop
		.invoke({ type: "app.settings.get", key: "soundEnabled" })
		.then((r) => {
			if (r.ok && r.data !== false) playSound(event);
		})
		.catch(() => {});
}
