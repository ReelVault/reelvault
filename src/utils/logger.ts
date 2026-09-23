import fs from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import { Writable } from "node:stream";
import type { Logger, LoggerConfig, LogMeta } from "@reelvault/sdk/common";
import pino, { type LoggerOptions, type Logger as PinoLogger } from "pino";
import { env } from "@/env";
import { serverConstants } from "@/server.constants";
import { hasEntry } from "./array.utils";
import { isRecord } from "./type.utils";

type LogDateProvider = () => string;

function formatDate(date: Date): string {
	const year = date.getFullYear();
	const month = String(date.getMonth() + 1).padStart(2, "0");
	const day = String(date.getDate()).padStart(2, "0");

	return `${year}-${month}-${day}`;
}

export function currentLogDate(): string {
	return formatDate(new Date());
}

/** Nth candidate archive path beside the active log: `name`, `name-1`, `name-2`, … in `directory`. */
function archiveTarget(directory: string, activePath: string, attempt: number): string {
	if (attempt === 0) return join(directory, basename(activePath));

	const extension = extname(activePath);
	const baseName = basename(activePath, extension);

	return join(directory, `${baseName}-${attempt}${extension}`);
}

function archivePath(activePath: string, date: string, callback: (target: string) => void): void {
	const directory = join(dirname(activePath), date);
	let attempt = 0;
	const probe = (): void => {
		const target = archiveTarget(directory, activePath, attempt);
		fs.stat(target, (error) => {
			if (error) {
				callback(target);

				return;
			}

			attempt += 1;
			probe();
		});
	};
	probe();
}

function archiveExistingFile(activePath: string, date: string, callback: (error?: Error | null) => void): void {
	fs.stat(activePath, (statError) => {
		if (statError) {
			// Nothing to archive yet.
			callback();

			return;
		}

		archivePath(activePath, date, (target) => {
			fs.mkdir(dirname(target), { recursive: true }, (mkdirError) => {
				if (mkdirError) {
					callback(mkdirError);

					return;
				}

				fs.rename(activePath, target, callback);
			});
		});
	});
}

export class DailyRotatingStream extends Writable {
	private stream: fs.WriteStream;
	private currentDate: string;
	private nextRolloverAt: number;
	private rotationWaiters: Array<(error?: Error | null) => void> = [];
	private rotationInFlight = false;
	private readonly activePath: string;
	private readonly dateProvider: LogDateProvider;
	private readonly usesWallClock: boolean;

	constructor(activePath: string, dateProvider: LogDateProvider = currentLogDate) {
		super();
		this.activePath = activePath;
		this.dateProvider = dateProvider;
		fs.mkdirSync(dirname(activePath), { recursive: true });
		this.usesWallClock = dateProvider === currentLogDate;
		this.currentDate = dateProvider();
		this.nextRolloverAt = this.usesWallClock ? nextDayBoundaryMs(this.currentDate) : 0;

		this.archiveStaleFile();

		this.stream = this.openStream();
	}

	override _write(chunk: Buffer | string, encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
		this.writeWithRotation(chunk, encoding, callback);
	}

	private writeToStream(chunk: Buffer | string, encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
		if (this.stream.write(chunk, encoding)) {
			callback();
		} else {
			this.stream.once("drain", () => callback());
		}
	}

	private writeWithRotation(chunk: Buffer | string, encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
		if (Date.now() < this.nextRolloverAt) {
			this.writeToStream(chunk, encoding, callback);

			return;
		}

		this.rotateIfNeeded((rotateError) => {
			if (rotateError) {
				callback(rotateError);

				return;
			}

			this.writeToStream(chunk, encoding, callback);
		});
	}

	override _final(callback: (error?: Error | null) => void): void {
		this.stream.end(() => callback());
	}

	private openStream(): fs.WriteStream {
		const stream = fs.createWriteStream(this.activePath, { flags: "a" });
		stream.on("error", (error) => this.destroy(error));

		return stream;
	}

	private archiveStaleFile(): void {
		try {
			const existing = fs.statSync(this.activePath, { throwIfNoEntry: false });
			if (!existing) return;

			const fileDate = currentLogDateFromTimestamp(existing.mtimeMs);
			if (fileDate === this.currentDate) return;

			const directory = join(dirname(this.activePath), fileDate);
			let target = archiveTarget(directory, this.activePath, 0);
			let attempt = 1;
			while (fs.existsSync(target)) {
				target = archiveTarget(directory, this.activePath, attempt);
				attempt += 1;
			}

			fs.mkdirSync(directory, { recursive: true });
			fs.renameSync(this.activePath, target);
		} catch {
			// best-effort — an archive failure must never crash the logger
		}
	}

	private rotateIfNeeded(callback: (error?: Error | null) => void): void {
		const nextDate = this.dateProvider();
		if (nextDate === this.currentDate) {
			if (this.usesWallClock) this.nextRolloverAt = nextDayBoundaryMs(this.currentDate);

			callback();

			return;
		}

		this.rotationWaiters.push(callback);
		if (this.rotationInFlight) return;

		this.rotationInFlight = true;
		this.performRotation(nextDate, (error) => {
			const waiters = this.rotationWaiters;
			this.rotationWaiters = [];
			this.rotationInFlight = false;
			for (const waiter of waiters) waiter(error);
		});
	}

	private performRotation(nextDate: string, callback: (error?: Error | null) => void): void {
		this.stream.end(() => {
			archiveExistingFile(this.activePath, this.currentDate, (archiveError) => {
				if (archiveError) {
					callback(archiveError);

					return;
				}

				this.currentDate = nextDate;
				this.nextRolloverAt = this.usesWallClock ? nextDayBoundaryMs(nextDate) : 0;
				this.stream = this.openStream();
				callback();
			});
		});
	}
}

function nextDayBoundaryMs(dateString: string): number {
	const year = Number(dateString.slice(0, 4));
	const month = Number(dateString.slice(5, 7));
	const day = Number(dateString.slice(8, 10));

	return new Date(year, month - 1, day + 1).getTime();
}

function currentLogDateFromTimestamp(timestamp: number): string {
	return formatDate(new Date(timestamp));
}

const SENSITIVE_KEYWORD_RE = /Bearer|token|password|secret|key/;

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

let cachedRootPino: PinoLogger | undefined;
let fileStreamsReady = isTest;
let rootBuildAttempts = 0;
const MAX_ROOT_BUILD_ATTEMPTS = 5;
let cachedPrettyStream: pino.StreamEntry | undefined;

function buildStreams(): pino.StreamEntry[] {
	const streams: pino.StreamEntry[] = [];

	if (!isTest) {
		try {
			const operationalStream = new DailyRotatingStream(serverConstants.paths.logFile);
			const debugStream = new DailyRotatingStream(serverConstants.paths.debugLogFile);
			streams.push({
				level: "info",
				stream: operationalStream,
			});
			streams.push({
				level: "debug",
				stream: debugStream,
			});
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
			streams.push({ level: "info", stream: process.stdout });
		}
	} else {
		streams.push({ level: "info", stream: process.stdout });
	}

	return streams;
}

const rootLoggerOptions: LoggerOptions = {
	level: isTest ? "silent" : "debug",
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

const SENSITIVE_LOG_KEY = /(authorization|cookie|password|secret|token|api[-_]?key|access[-_]?token|refresh[-_]?token|storage[-_]?key)/i;

const BEARER_REDACT = /(Bearer\s+)[^\s]+/gi;
const SECRET_REDACT = /((?:password|token|secret|api[-_]?key)=)[^&\s]+/gi;

export function sanitizeLogValue<T>(value: T, key?: string): T;

export function sanitizeLogValue(value: unknown, key?: string): unknown {
	if (!needsSanitization(value, key, null, 0)) {
		return value;
	}

	return sanitizeLogValueInner(value, key, new WeakSet(), 0);
}

const MAX_SANITIZE_DEPTH = 8;

function needsSanitization(value: unknown, key: string | undefined, seen: WeakSet<object> | null, depth: number): boolean {
	if (key && SENSITIVE_LOG_KEY.test(key)) return true;

	if (value == null) return false;

	if (typeof value === "number" || typeof value === "boolean" || typeof value === "symbol" || typeof value === "bigint") return false;

	if (value instanceof Error) return true;

	if (typeof value === "string") {
		return SENSITIVE_KEYWORD_RE.test(value);
	}

	if (depth >= MAX_SANITIZE_DEPTH) return false;

	if (Array.isArray(value)) {
		const seenSet = seen ?? new WeakSet<object>();
		if (seenSet.has(value)) return false;

		seenSet.add(value);
		for (const item of value) {
			if (needsSanitization(item, undefined, seenSet, depth + 1)) {
				seenSet.delete(value);

				return true;
			}
		}

		seenSet.delete(value);

		return false;
	}

	if (isRecord(value)) {
		const seenSet = seen ?? new WeakSet<object>();
		if (seenSet.has(value)) return false;

		seenSet.add(value);

		for (const entryKey of Object.keys(value)) {
			const entryValue: unknown = value[entryKey];
			if (needsSanitization(entryValue, entryKey, seenSet, depth + 1)) {
				seenSet.delete(value);

				return true;
			}
		}

		seenSet.delete(value);

		return false;
	}

	return false;
}

function sanitizeLogValueInner(value: unknown, key: string | undefined, seen: WeakSet<object>, depth: number): unknown {
	if (key && SENSITIVE_LOG_KEY.test(key)) return "[REDACTED]";

	if (value == null) return value;

	if (typeof value === "number" || typeof value === "boolean" || typeof value === "symbol" || typeof value === "bigint") return value;

	if (value instanceof Error) {
		// The cause chain carries the actionable detail (e.g. the raw SQLite
		// message behind a wrapped DrizzleQueryError) — without it, logged
		// failures stop at "Failed query" and are undiagnosable.
		const cause = "cause" in value ? (value as { cause?: unknown }).cause : undefined;

		return {
			name: value.name,
			message: redactSensitiveText(value.message),
			stack: value.stack ? redactSensitiveText(value.stack) : undefined,
			...(cause !== undefined && { cause: sanitizeLogValueInner(cause, "cause", seen, depth + 1) }),
		};
	}

	if (typeof value === "string") {
		return redactSensitiveText(value);
	}

	if (depth >= MAX_SANITIZE_DEPTH) return "[MaxDepth]";

	if (Array.isArray(value)) {
		if (seen.has(value)) return "[Circular]";

		seen.add(value);
		const result = value.map((item) => sanitizeLogValueInner(item, undefined, seen, depth + 1));
		seen.delete(value);

		return result;
	}

	if (isRecord(value)) {
		if (seen.has(value)) return "[Circular]";

		seen.add(value);
		const result: Record<string, unknown> = {};
		for (const entryKey of Object.keys(value)) {
			const entryValue: unknown = value[entryKey];
			result[entryKey] = sanitizeLogValueInner(entryValue, entryKey, seen, depth + 1);
		}

		seen.delete(value);

		return result;
	}

	return value;
}

function redactSensitiveText(value: string): string {
	if (!SENSITIVE_KEYWORD_RE.test(value)) {
		return value;
	}

	return value.replace(BEARER_REDACT, "$1[REDACTED]").replace(SECRET_REDACT, "$1[REDACTED]");
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

export const createLogger = (name: string, config?: Omit<LoggerConfig, "name">) => new AppLogger(undefined, { ...config, name });
