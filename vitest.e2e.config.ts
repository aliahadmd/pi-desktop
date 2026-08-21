import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["tests/e2e/**/*.e2e.ts"],
		environment: "node",
		testTimeout: 60_000,
		hookTimeout: 120_000,
		pool: "forks",
		maxWorkers: 1,
		minWorkers: 1,
	},
});
