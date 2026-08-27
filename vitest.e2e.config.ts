import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["tests/e2e/**/*.e2e.ts"],
		environment: "node",
		testTimeout: 60_000,
		hookTimeout: 120_000,
		pool: "forks",
		// vitest 4 removed top-level `minWorkers`; maxWorkers: 1 keeps e2e serial.
		maxWorkers: 1,
	},
});
