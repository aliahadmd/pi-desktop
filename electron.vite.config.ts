import { defineConfig } from "electron-vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { externalizeDepsPlugin } from "electron-vite";

export default defineConfig({
	main: {
		plugins: [externalizeDepsPlugin()],
		build: {
			rollupOptions: {
				input: { index: "src/main/index.ts" },
			},
		},
	},
	preload: {
		plugins: [externalizeDepsPlugin()],
		build: {
			rollupOptions: {
				input: { index: "src/preload/index.ts" },
				output: {
					format: "cjs", // sandboxed preload scripts must be CJS
					entryFileNames: "[name].js",
				},
			},
		},
	},
	renderer: {
		root: "src/renderer",
		plugins: [react(), tailwindcss()],
		build: {
			rollupOptions: {
				input: { index: "src/renderer/index.html" },
			},
		},
	},
});
