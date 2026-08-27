/**
 * Sheet focus management (audit 6 M-20 + M-27). A DOM-level test would need
 * jsdom + motion's animation plumbing; these source pins catch the actual
 * regression shapes: focus staying behind the sheet, Tab escaping it, and Esc
 * discarding an uncommitted onBlur-save edit.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SHEET = readFileSync(
	join(import.meta.dirname, "../../src/renderer/src/components/shell/Sheet.tsx"),
	"utf8"
);

describe("Sheet focus trap (audit 6 M-20)", () => {
	it("exposes modal dialog semantics", () => {
		expect(SHEET).toContain('role="dialog"');
		expect(SHEET).toContain('aria-modal="true"');
		expect(SHEET).toContain("aria-label={title}");
		// Focusable programmatically, not via tab order.
		expect(SHEET).toContain("tabIndex={-1}");
	});

	it("moves focus into the sheet on open (and back on close)", () => {
		expect(SHEET).toContain("triggerRef.current = document.activeElement");
		expect(SHEET).toContain("sheetRef.current?.focus()");
	});

	it("loops Tab/Shift+Tab within the sheet", () => {
		expect(SHEET).toContain('e.key !== "Tab"');
		expect(SHEET).toContain("querySelectorAll<HTMLElement>(FOCUSABLE)");
		expect(SHEET).toContain("last.focus()");
		expect(SHEET).toContain("first.focus()");
		expect(SHEET).toContain("e.preventDefault()");
	});
});

describe("Sheet Esc handling (audit 6 M-27)", () => {
	it("blurs the focused control BEFORE closing so onBlur-save commits", () => {
		const at = SHEET.indexOf('e.key === "Escape"');
		expect(at).toBeGreaterThanOrEqual(0);
		const body = SHEET.slice(at, at + 400);
		const blur = body.indexOf(".blur()");
		const close = body.indexOf("onClose()");
		expect(blur).toBeGreaterThanOrEqual(0);
		expect(close).toBeGreaterThan(blur);
	});
});
