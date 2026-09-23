import type { Database } from "bun:sqlite";
import type { Logger } from "drizzle-orm/logger";
import { createLogger } from "@/utils/logger";

const log = createLogger("QueryLogger");

export interface QueryLoggerOptions {
	enabled?: boolean | undefined;
	slowThresholdMs?: number | undefined;
}

export class DatabaseQueryLogger implements Logger {
	private readonly enabled: boolean;
	private readonly slowThresholdMs: number;
	private queryCount = 0;
	private slowQueryCount = 0;

	constructor(options?: QueryLoggerOptions) {
		this.enabled = options?.enabled ?? false;
		this.slowThresholdMs = options?.slowThresholdMs ?? 100;
	}

	isEnabled(): boolean {
		return this.enabled;
	}

	// Called by Drizzle right before a statement executes; used for counting only.
	// Actual duration is reported by the instrumented statement via `recordQuery`.
	logQuery(_query: string, _params: unknown[]): void {
		if (!this.enabled) return;

		this.queryCount++;
	}

	recordQuery(query: string, params: unknown[], durationMs: number): void {
		if (!this.enabled) return;

		if (durationMs >= this.slowThresholdMs) {
			this.slowQueryCount++;
			log.warn("Slow query detected", {
				query: query.slice(0, 500),
				params: params.length > 0 ? params : undefined,
				durationMs,
				slowThresholdMs: this.slowThresholdMs,
			});
		} else {
			log.debug("Query executed", {
				query: query.slice(0, 300),
				durationMs,
			});
		}
	}

	getStats(): { queryCount: number; slowQueryCount: number } {
		return { queryCount: this.queryCount, slowQueryCount: this.slowQueryCount };
	}

	resetStats(): void {
		this.queryCount = 0;
		this.slowQueryCount = 0;
	}
}

const timedStatementMethods = new Set(["run", "all", "get", "values"]);

type BunQueryStatement = ReturnType<Database["query"]>;

function instrumentStatement(statement: BunQueryStatement, query: string, logger: DatabaseQueryLogger): BunQueryStatement {
	return new Proxy(statement, {
		get(target, property, receiver) {
			if (typeof property === "string" && timedStatementMethods.has(property)) {
				const original: unknown = Reflect.get(target, property, receiver);
				if (typeof original !== "function") return original;

				return (...args: unknown[]): unknown => {
					const start = performance.now();
					try {
						const result: unknown = original.apply(target, args);

						return result;
					} finally {
						logger.recordQuery(query, args, Math.round(performance.now() - start));
					}
				};
			}

			const value: unknown = Reflect.get(target, property, receiver);
			const bound: unknown = typeof value === "function" ? value.bind(target) : value;

			return bound;
		},
	});
}

/**
 * Wraps the bun:sqlite client so statement execution time can be measured around the
 * actual native call (Drizzle's Logger has no "query finished" hook). Returns the client
 * unchanged when logging is disabled.
 */
export function instrumentSqliteClient(client: Database, logger: DatabaseQueryLogger): Database {
	if (!logger.isEnabled()) return client;

	const prepareStatement = (statement: BunQueryStatement, sql: string) => instrumentStatement(statement, sql, logger);

	return new Proxy(client, {
		get(target, property) {
			if (property === "query") {
				return (query: string) => prepareStatement(target.query(query), query);
			}

			if (property === "prepare") {
				return (query: string) => prepareStatement(target.prepare(query), query);
			}

			const value: unknown = Reflect.get(target, property);
			const bound: unknown = typeof value === "function" ? value.bind(target) : value;

			return bound;
		},
	});
}
