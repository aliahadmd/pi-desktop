/**
 * Structured JSONL logger. One file per day under userData/logs, retained for
 * 14 days (pruned at boot by paths.pruneOldLogs). Renderer console output is
 * forwarded over IPC and written to the same stream with source="renderer".
 */
import { appendFileSync, renameSync, statSync } from "node:fs";
import path from "node:path";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface Logger {
	debug(source: "main" | "renderer", ...args: unknown[]): void;
	info(source: "main" | "renderer", ...args: unknown[]): void;
	warn(source: "main" | "renderer", ...args: unknown[]): void;
	error(source: "main" | "renderer", ...args: unknown[]): void;
}

const MAX_LOG_BYTES = 5 * 1024 * 1024;

interface LogEntry {
	ts: number;
	level: LogLevel;
	source: "main" | "renderer";
	args: string[];
}

export function createLogger(logsDir: string): Logger {
	return new FileLogger(logsDir);
}

class FileLogger implements Logger {
	private readonly logsDir: string;

	constructor(logsDir: string) {
		this.logsDir = logsDir;
	}

	debug(source: "main" | "renderer", ...args: unknown[]): void {
		this.write("debug", source, args);
	}
	info(source: "main" | "renderer", ...args: unknown[]): void {
		this.write("info", source, args);
	}
	warn(source: "main" | "renderer", ...args: unknown[]): void {
		this.write("warn", source, args);
	}
	error(source: "main" | "renderer", ...args: unknown[]): void {
		this.write("error", source, args);
	}

	private write(level: LogLevel, source: "main" | "renderer", args: unknown[]): void {
		const entry: LogEntry = {
			ts: Date.now(),
			level,
			source,
			args: args.map(formatValue),
		};
		const line = JSON.stringify(entry);
		try {
			const filePath = this.todayFile();
			this.rotateIfNeeded(filePath);
			appendFileSync(filePath, `${line}\n`, { encoding: "utf8" });
		} catch {
			// logging must never crash the app
		}
		if (level !== "debug") {
			const sink = level === "error" ? console.error : console.log;
			sink(`[pi-desktop][${level}][${source}]`, ...entry.args);
		}
	}

	private todayFile(): string {
		const date = new Date();
		const y = date.getFullYear();
		const m = String(date.getMonth() + 1).padStart(2, "0");
		const d = String(date.getDate()).padStart(2, "0");
		return path.join(this.logsDir, `pidesktop-${y}${m}${d}.log`);
	}

	private rotateIfNeeded(filePath: string): void {
		try {
			if (statSync(filePath).size < MAX_LOG_BYTES) return;
			renameSync(filePath, `${filePath}.${Date.now()}.rotated`);
		} catch {
			// file likely does not exist yet
		}
	}
}

function formatValue(value: unknown): string {
	if (value instanceof Error) return value.stack ?? value.message;
	if (typeof value === "string") return value;
	try {
		return JSON.stringify(value) ?? String(value);
	} catch {
		return String(value);
	}
}
