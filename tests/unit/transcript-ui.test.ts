/**
 * Transcript row UI state (audit M-2). Rows are virtualized, so expand/dismiss
 * state must live outside the component or it is lost on scroll.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { useTranscriptUi } from "../../src/renderer/src/stores/transcript-ui";

beforeEach(() => {
	useTranscriptUi.setState({ expanded: new Set(), dismissed: new Set() });
});

describe("transcript row state", () => {
	it("defaults to the fallback when untouched", () => {
		const s = useTranscriptUi.getState();
		expect(s.isExpanded("a:1", true)).toBe(true);
		expect(s.isExpanded("a:2", false)).toBe(false);
	});

	it("toggling deviates from the fallback", () => {
		useTranscriptUi.getState().toggleExpanded("a:1", true);
		expect(useTranscriptUi.getState().isExpanded("a:1", true)).toBe(false);
	});

	it("toggling twice returns to the fallback", () => {
		useTranscriptUi.getState().toggleExpanded("a:1", false);
		useTranscriptUi.getState().toggleExpanded("a:1", false);
		expect(useTranscriptUi.getState().isExpanded("a:1", false)).toBe(false);
	});

	it("dismiss is sticky", () => {
		expect(useTranscriptUi.getState().isDismissed("a:3")).toBe(false);
		useTranscriptUi.getState().dismiss("a:3");
		expect(useTranscriptUi.getState().isDismissed("a:3")).toBe(true);
	});

	it("keys are namespaced per session", () => {
		useTranscriptUi.getState().dismiss("s1:n1");
		expect(useTranscriptUi.getState().isDismissed("s2:n1")).toBe(false);
	});

	it("clearSession drops only that session's rows", () => {
		const s = useTranscriptUi.getState();
		s.dismiss("s1:n1");
		s.dismiss("s2:n1");
		s.toggleExpanded("s1:t1", false);
		useTranscriptUi.getState().clearSession("s1");
		const after = useTranscriptUi.getState();
		expect(after.isDismissed("s1:n1")).toBe(false);
		expect(after.isDismissed("s2:n1")).toBe(true);
		expect(after.isExpanded("s1:t1", false)).toBe(false);
	});
});
