/**
 * Transcript row UI state (audit M-2). Rows are virtualized, so expand/dismiss
 * state must live outside the component or it is lost on scroll.
 *
 * Audit 6 M-17: expansion is an EXPLICIT boolean per key, not a
 * "deviation from the default" bit — the default is dynamic (running tools
 * default to expanded), and the old scheme re-expanded a user-collapsed tool
 * the moment it finished.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { useTranscriptUi } from "../../src/renderer/src/stores/transcript-ui";

beforeEach(() => {
	useTranscriptUi.setState({
		expanded: new Map(),
		dismissed: new Set(),
		copied: new Set(),
	});
});

describe("transcript row state", () => {
	it("defaults to the fallback when untouched", () => {
		const s = useTranscriptUi.getState();
		expect(s.isExpanded("a:1", true)).toBe(true);
		expect(s.isExpanded("a:2", false)).toBe(false);
	});

	it("toggling flips the effective state", () => {
		useTranscriptUi.getState().toggleExpanded("a:1", true);
		expect(useTranscriptUi.getState().isExpanded("a:1", true)).toBe(false);
	});

	it("toggling twice returns to the original state", () => {
		useTranscriptUi.getState().toggleExpanded("a:1", false);
		useTranscriptUi.getState().toggleExpanded("a:1", false);
		expect(useTranscriptUi.getState().isExpanded("a:1", false)).toBe(false);
	});

	it("M-17: a flipped fallback does not resurrect an explicit choice", () => {
		// Running tool defaults to expanded; user collapses it…
		useTranscriptUi.getState().toggleExpanded("a:1", true);
		// …the tool finishes, so the row's fallback flips to collapsed. The
		// explicit choice must hold instead of re-expanding itself.
		expect(useTranscriptUi.getState().isExpanded("a:1", false)).toBe(false);
	});

	it("M-17: untouched rows keep following the fallback when it flips", () => {
		expect(useTranscriptUi.getState().isExpanded("a:1", true)).toBe(true);
		expect(useTranscriptUi.getState().isExpanded("a:1", false)).toBe(false);
	});

	it("M-17: toggle acts on the CURRENT effective state, not the fallback bit", () => {
		// Row shows expanded (fallback true). One toggle collapses; a second
		// expands again — symmetric regardless of which fallback is passed.
		useTranscriptUi.getState().toggleExpanded("a:1", true);
		useTranscriptUi.getState().toggleExpanded("a:1", true);
		expect(useTranscriptUi.getState().isExpanded("a:1", true)).toBe(true);
	});

	it("setExpanded pins a value (assistant tool-chip expand)", () => {
		useTranscriptUi.getState().setExpanded("a:1", true);
		expect(useTranscriptUi.getState().isExpanded("a:1", false)).toBe(true);
		useTranscriptUi.getState().setExpanded("a:1", true);
		expect(useTranscriptUi.getState().isExpanded("a:1", false)).toBe(true);
	});

	it("dismiss is sticky", () => {
		expect(useTranscriptUi.getState().isDismissed("a:3")).toBe(false);
		useTranscriptUi.getState().dismiss("a:3");
		expect(useTranscriptUi.getState().isDismissed("a:3")).toBe(true);
	});

	it("copied feedback marks and unmarks (audit 6 L-12)", () => {
		expect(useTranscriptUi.getState().isCopied("a:4")).toBe(false);
		useTranscriptUi.getState().markCopied("a:4");
		expect(useTranscriptUi.getState().isCopied("a:4")).toBe(true);
		useTranscriptUi.getState().unmarkCopied("a:4");
		expect(useTranscriptUi.getState().isCopied("a:4")).toBe(false);
	});

	it("unmarkCopied on an unmarked key is a no-op (timer fired twice)", () => {
		useTranscriptUi.getState().unmarkCopied("a:ghost");
		expect(useTranscriptUi.getState().isCopied("a:ghost")).toBe(false);
	});

	it("keys are namespaced per session", () => {
		useTranscriptUi.getState().dismiss("s1:n1");
		expect(useTranscriptUi.getState().isDismissed("s2:n1")).toBe(false);
	});

	it("clearSession drops only that session's rows", () => {
		const s = useTranscriptUi.getState();
		s.dismiss("s1:n1");
		s.dismiss("s2:n1");
		s.setExpanded("s1:t1", false);
		s.markCopied("s1:c1");
		useTranscriptUi.getState().clearSession("s1");
		const after = useTranscriptUi.getState();
		expect(after.isDismissed("s1:n1")).toBe(false);
		expect(after.isDismissed("s2:n1")).toBe(true);
		expect(after.isExpanded("s1:t1", true)).toBe(true);
		expect(after.isCopied("s1:c1")).toBe(false);
	});
});
