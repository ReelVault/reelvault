import { describe, expect, test } from "bun:test";
import { DomainError } from "./domain.errors";
import { createLogger } from "./logger.utils";
import { runSafely, type SafeExecuteContext } from "./safe-execute.utils";

const service: SafeExecuteContext = { serviceName: "TestService", logger: createLogger("TestService") };

describe("runSafely", () => {
	test("executes async operation successfully and returns result", async () => {
		const result = await runSafely(service, "testOp", async () => "success");
		expect(result).toBe("success");
	});

	test("executes sync operation successfully and returns result", async () => {
		const result = await runSafely(service, "testSync", () => 42);
		expect(result).toBe(42);
	});

	test("re-throws DomainError as-is without wrapping in InternalError", async () => {
		const notFound = new DomainError("not_found", "Item not found");

		await expect(
			runSafely(service, "testDomainError", () => {
				throw notFound;
			}),
		).rejects.toBe(notFound);
	});

	test("wraps unexpected errors as an internal error that keeps the cause", async () => {
		const rawError = new Error("DB connection timeout");
		const error = await runSafely(service, "testOp", () => {
			throw rawError;
		}).catch((caught: unknown) => caught);

		expect(error).toMatchObject({ category: "internal" });
		expect((error as DomainError).cause).toBe(rawError);
	});

	test("supports customThrow as an Error instance", async () => {
		const rawError = new Error("Unique constraint violation");
		const conflict = new DomainError("conflict", "Username already exists");
		const error = await runSafely(
			service,
			"register",
			() => {
				throw rawError;
			},
			{ customThrow: conflict },
		).catch((caught: unknown) => caught);

		expect(error).toBe(conflict);
		expect((error as DomainError).cause).toBe(rawError);
	});

	test("supports customThrow as a factory function receiving the cause", async () => {
		const rawError = new Error("Foreign key violation");
		let received: unknown;
		const error = await runSafely(
			service,
			"createItem",
			() => {
				throw rawError;
			},
			{
				customThrow: (cause) => {
					received = cause;

					return new DomainError("validation", "Invalid reference");
				},
			},
		).catch((caught: unknown) => caught);

		expect(received).toBe(rawError);
		expect(error).toMatchObject({ category: "validation" });
		expect((error as DomainError).cause).toBe(rawError);
	});
});
