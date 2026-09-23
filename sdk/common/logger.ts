export type LogMeta = Record<string, unknown>;

export type LogLevel = "trace" | "debug" | "info" | "warn" | "error" | "fatal";

export interface LoggerConfig {
	name?: string | undefined;
	level?: LogLevel | undefined;
	prettyPrint?: boolean | undefined;
}

/**
 * Logger interface for plugins
 *
 * @example
 * ```typescript
 * // Basic logging
 * ctx.logger.info("Plugin initialized");
 * ctx.logger.error("Failed to process", error);
 *
 * // With metadata
 * ctx.logger.info("Processing file", {
 *   fileName: "movie.mp4",
 *   size: 1024 * 1024 * 500
 * });
 *
 * // Child logger
 * const jobLogger = ctx.logger.child({ jobId: "123" });
 * jobLogger.info("Job started"); // Will include jobId in all logs
 *
 * // Timing
 * const done = ctx.logger.time("Processing video");
 * // ... do work ...
 * done("Processing completed"); // Logs with duration
 * ```
 */
export interface Logger {
	/**
	 * Trace level log (most verbose)
	 */
	trace(message: string, meta?: LogMeta): void;

	/**
	 * Debug level log
	 */
	debug(message: string, meta?: LogMeta): void;

	/**
	 * Info level log
	 */
	info(message: string, meta?: LogMeta): void;

	/**
	 * Warning level log
	 */
	warn(message: string, meta?: LogMeta): void;

	/**
	 * Error level log
	 */
	error(message: string, error?: unknown, meta?: LogMeta): void;

	/**
	 * Fatal level log (most severe)
	 */
	fatal(message: string, error?: unknown, meta?: LogMeta): void;

	/**
	 * Create child logger with persistent context
	 *
	 * @param context - Context to add to all child logs
	 * @returns Child logger instance
	 */
	child<T extends Record<string, unknown>>(context: T): Logger;

	/**
	 * Time an operation
	 *
	 * @param label - Operation label
	 * @param meta - Optional metadata
	 * @returns Function to call when operation is done
	 *
	 * @example
	 * ```typescript
	 * const done = logger.time("Processing");
	 * // ... do work ...
	 * done("Processing completed"); // Logs with duration
	 * ```
	 */
	time(label: string, meta?: LogMeta): (finishLabel: string, meta?: LogMeta) => void;
}
