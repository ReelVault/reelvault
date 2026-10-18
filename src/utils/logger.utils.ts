import type { Logger, LoggerConfig, LogMeta } from "@reelvault/sdk/common";
import pino, { type LevelWithSilentOrString, type LoggerOptions, type Logger as PinoLogger } from "pino";
import { env } from "@/config/env.config";
import { serverConstants } from "@/config/server/server.constants";
import { hasEntry } from "./array.utils";
import { CoalescingStream } from "./logging/coalescing.stream";
import { DailyRotatingStream } from "./logging/daily-rotating.stream";
import { sanitizeLogValue } from "./logging/sanitize.utils";
import { isRecord } from "./type.utils";

function formatDuration(ms: number, showMs = false): string {
	const totalSeconds = Math.floor(ms / 1000);
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	let result = `${minutes}:${seconds.toString().padStart(2, "0")}`;
	if (showMs) {
		result += `.${Math.floor(ms % 1000)
			.toString()
			.padStart(3, "0")}`;
	}

	return result;
}

const isDev = env.NODE_ENV === "development";
const isTest = env.NODE_ENV === "test";
// The debug log file only carries unique records when the root level emits
// debug/trace; at info+ it would just duplicate the operational file.
const debugFileEnabled = env.LOG_LEVEL === "debug" || env.LOG_LEVEL === "trace";

let cachedRootPino: PinoLogger | undefined;
let fileStreamsReady = isTest;
let rootBuildAttempts = 0;
const MAX_ROOT_BUILD_ATTEMPTS = 5;
let cachedPrettyStream: pino.StreamEntry | undefined;
/** Info-level JSON destinations for the access fast path (undefined = use pino). */
let accessLineSinks: CoalescingStream[] | undefined;
/** Every coalescing sink behind the file and stdout streams; `flushLogs` drains them before exit. */
let logSinks: CoalescingStream[] = [];

function buildStreams(): pino.StreamEntry[] {
	const streams: pino.StreamEntry[] = [];
	accessLineSinks = undefined;

	if (!isTest) {
		const jsonSinks: CoalescingStream[] = [];
		logSinks = jsonSinks;
		try {
			const operationalStream = new CoalescingStream(new DailyRotatingStream(serverConstants.paths.logFile));
			streams.push({
				level: "info",
				stream: operationalStream,
			});
			jsonSinks.push(operationalStream);
			if (debugFileEnabled) {
				const debugStream = new CoalescingStream(new DailyRotatingStream(serverConstants.paths.debugLogFile));
				streams.push({
					level: "debug",
					stream: debugStream,
				});
				jsonSinks.push(debugStream);
			}

			fileStreamsReady = true;
		} catch (error) {
			console.error("[logger] file log streams unavailable — retrying a few times, then file logging stays off:", error);
		}

		if (isDev) {
			cachedPrettyStream ??= {
				level: "debug",
				stream: pino.transport({
					target: "pino-pretty",
					options: {
						colorize: true,
						translateTime: "HH:MM:ss",
						ignore: "pid,hostname,module",
						messageFormat: "[{module}] {msg}",
					},
				}),
			};
			streams.push(cachedPrettyStream);
		} else {
			const stdoutStream = new CoalescingStream(process.stdout);
			streams.push({ level: "info", stream: stdoutStream });
			jsonSinks.push(stdoutStream);
			// Raw-JSON console (not pino-pretty): the access fast path can write
			// the same bytes to every info-level destination pino would.
			accessLineSinks = jsonSinks;
		}
	} else {
		streams.push({ level: "info", stream: process.stdout });
	}

	return streams;
}

/** Writes the log lines accepted so far to their files or stdout. Call before `process.exit`. */
export async function flushLogs(): Promise<void> {
	await Promise.all(logSinks.map((sink) => sink.drain()));
}

const rootLoggerOptions: LoggerOptions = {
	// Tests stay silent (preload); otherwise honor LOG_LEVEL, defaulting to info
	// so production does not pay for per-service debug tracing by default.
	level: isTest ? "silent" : env.LOG_LEVEL,
	base: {
		module: "Server",
	},
};

function getRootPino(): PinoLogger {
	const settled = fileStreamsReady || rootBuildAttempts >= MAX_ROOT_BUILD_ATTEMPTS;
	if (cachedRootPino && settled) return cachedRootPino;

	rootBuildAttempts += 1;
	cachedRootPino = pino(rootLoggerOptions, pino.multistream(buildStreams()));

	return cachedRootPino;
}

/**
 * Applies a runtime log level (settings side effect). The level gates every
 * stream; the separate debug log file still only exists when the boot level
 * was debug/trace.
 */
export function setLogLevel(level: LevelWithSilentOrString): void {
	rootLoggerOptions.level = level;
	if (cachedRootPino) cachedRootPino.level = level;
}

/** The level the root logger writes at now, including a change made at runtime from the settings. */
export function currentLogLevel(): LevelWithSilentOrString {
	return rootLoggerOptions.level ?? "info";
}

/**
 * Access-log fast path. The request logger builds its record from server-side
 * values only (request id, path, method, duration, status, user/profile ids),
 * and the path never includes the query string — no user-supplied credentials,
 * so the generic sanitizer is unnecessary. Writing the line straight to the
 * info-level JSON destinations skips pino's per-line machinery (child bindings
 * merge, `_asJson`, level dispatch): a CPU profile put that at ~12% of the
 * cached catalog-browse path at `info`. The shape matches pino's output for the
 * same record, including the repeated `module` key its base + child bindings
 * produce. Unavailable in development (pino-pretty console) and tests, where
 * callers fall back to the regular logger.
 */
/** pino's numeric level for `info` (RFC 5424), used to build access lines. */
const ACCESS_LEVEL: number = pino.levels.values.info ?? 30;

function infoLevelEnabled(): boolean {
	const value: number | undefined = pino.levels.values[currentLogLevel()];

	return value !== undefined && value <= ACCESS_LEVEL;
}

/** One access-log JSON line, byte-compatible with pino's output for the record. */
export function formatAccessLine(message: string, meta: LogMeta): string {
	const serialized = JSON.stringify(meta);
	const body = serialized.length > 2 ? `${serialized.slice(1, -1)},` : "";

	return `{"level":${ACCESS_LEVEL},"time":${Date.now()},"module":"Server","module":"RequestLogger",${body}"msg":${JSON.stringify(message)}}`;
}

/**
 * Writes the access record through the fast path. Returns false when the fast
 * path is unavailable, so the caller logs through the regular logger instead.
 */
export function logAccessRecord(message: string, meta: LogMeta): boolean {
	const sinks = accessLineSinks;
	if (!sinks) return false;

	if (infoLevelEnabled()) {
		const line = `${formatAccessLine(message, meta)}\n`;
		for (const sink of sinks) sink.write(line);
	}

	return true;
}

class AppLogger implements Logger {
	private cachedPino?: PinoLogger | undefined;
	private readonly base?: PinoLogger | undefined;
	private readonly config?: LoggerConfig | undefined;

	constructor(base?: PinoLogger, config?: LoggerConfig) {
		this.base = base;
		this.config = config;
	}

	private resolve(): PinoLogger {
		if (!this.cachedPino) {
			if (this.base) {
				this.cachedPino = this.base;
			} else {
				const moduleName = this.config?.name ?? "Server";
				const child = getRootPino().child({ module: moduleName });
				if (this.config?.level) child.level = this.config.level;

				this.cachedPino = child;
			}
		}

		return this.cachedPino;
	}

	private log(level: pino.Level, message: string, meta?: LogMeta): void {
		const logger = this.resolve();
		if (!logger.isLevelEnabled(level)) return;

		const safeMeta = meta ? sanitizeLogValue(meta) : undefined;

		const hasKeys = hasEntry(safeMeta);
		if (hasKeys) {
			logger[level](safeMeta, message);
		} else {
			logger[level](message);
		}
	}

	private logErrorOrFatal(level: "error" | "fatal", message: string, arg2?: unknown, arg3?: LogMeta): void {
		let errObj: unknown;
		let metaObj: LogMeta | undefined;

		if (arg3 !== undefined) {
			errObj = arg2;
			metaObj = arg3;
		} else if (arg2 !== undefined) {
			if (arg2 instanceof Error) {
				errObj = arg2;
			} else if (typeof arg2 === "object" && arg2 !== null && ("stack" in arg2 || "message" in arg2 || "name" in arg2)) {
				errObj = arg2;
			} else if (isRecord(arg2)) {
				metaObj = arg2;
			} else {
				errObj = arg2;
			}
		}

		const payload: Record<string, unknown> = { ...(metaObj ? sanitizeLogValue(metaObj) : undefined) };

		if (errObj instanceof Error) {
			payload.err = sanitizeLogValue(errObj);
		} else if (errObj != null) {
			payload.errorDetails = sanitizeLogValue(errObj);
		}

		this.resolve()[level](payload, message);
	}

	trace(message: string, meta?: LogMeta): void {
		this.log("trace", message, meta);
	}

	debug(message: string, meta?: LogMeta): void {
		this.log("debug", message, meta);
	}

	info(message: string, meta?: LogMeta): void {
		this.log("info", message, meta);
	}

	warn(message: string, meta?: LogMeta): void {
		this.log("warn", message, meta);
	}

	error(message: string, error?: unknown, meta?: LogMeta): void {
		this.logErrorOrFatal("error", message, error, meta);
	}

	fatal(message: string, error?: unknown, meta?: LogMeta): void {
		this.logErrorOrFatal("fatal", message, error, meta);
	}

	child(context: LogMeta): Logger {
		return new AppLogger(this.resolve().child(sanitizeLogValue(context)));
	}

	time(label: string, meta?: LogMeta): (finishLabel: string, meta?: LogMeta) => void {
		const start = performance.now();
		this.info(label, meta);

		return (finishLabel: string, finishMeta?: LogMeta) => {
			const durationMs = Math.round(performance.now() - start);
			this.info(finishLabel, {
				...finishMeta,
				durationMs,
				duration: formatDuration(durationMs, true),
			});
		};
	}
}

export const logger = new AppLogger();

export function createLogger(name: string, config?: Omit<LoggerConfig, "name">) {
	return new AppLogger(undefined, { ...config, name });
}
