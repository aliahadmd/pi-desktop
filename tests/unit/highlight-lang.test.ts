import { describe, expect, it } from "vitest";
import { langFor } from "../../src/renderer/src/lib/highlight";

describe("langFor (phase 7 code highlighting)", () => {
	it("maps common file extensions", () => {
		expect(langFor("server.py")).toBe("python");
		expect(langFor("index.ts")).toBe("typescript");
		expect(langFor("App.tsx")).toBe("tsx");
		expect(langFor("style.css")).toBe("css");
		expect(langFor("compose.yml")).toBe("yaml");
		expect(langFor("Dockerfile")).toBe("dockerfile");
	});

	it("accepts explicit language tags", () => {
		expect(langFor("python")).toBe("python");
		expect(langFor("TS")).toBe("typescript");
		expect(langFor("bash")).toBe("bash");
	});

	it("returns text for unknown extensions and empty input", () => {
		expect(langFor("data.xyz123")).toBe("text");
		expect(langFor("")).toBe("text");
		expect(langFor("text")).toBe("text");
	});

	it("handles full paths by using the final extension", () => {
		expect(langFor("/Users/ahs/project/src/main.rs")).toBe("rust");
	});
});
