import { describe, expect, test } from "bun:test";
import { DomainError } from "./errors";
import { createLogger } from "./logger";
import { runSafely, type SafeExecuteContext } from "./safe-execute";

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

	test("re-throws DomainError as-is without wrapping in InternalError", () => {
		const notFound = new DomainError("not_found", "Item not found");

		expect(
			runSafely(service, "testDomainError", () => {
				throw notFound;
			}),
		).rejects.toThrow(notFound);
	});

	test("wraps unexpected errors in InternalError with default message", async () => {
		const rawError = new Error("DB connection timeout");

		try {
			await runSafely(service, "testOp", () => {
				throw rawError;
			});
			expect.unreachable();
		} catch (error) {
			expect(error).toMatchObject({ category: "internal" });
			expect((error as DomainError).message).toBe("TestService.testOp failed");
			expect((error as DomainError).cause).toBe(rawError);
		}
	});

	test("supports custom errorMessage in options", async () => {
		const rawError = new Error("Connection reset");

		try {
			await runSafely(
				service,
				"customMessageOp",
				() => {
					throw rawError;
				},
				{ errorMessage: "could not connect to database" },
			);
			expect.unreachable();
		} catch (error) {
			expect(error).toMatchObject({ category: "internal" });
			expect((error as DomainError).message).toBe("TestService.customMessageOp could not connect to database");
			expect((error as DomainError).cause).toBe(rawError);
		}
	});

	test("supports backward compatible string as 3rd argument for errorMessage", async () => {
		const rawError = new Error("Connection reset");

		try {
			await runSafely(
				service,
				"legacyOp",
				() => {
					throw rawError;
				},
				"legacy failure description",
			);
			expect.unreachable();
		} catch (error) {
			expect(error).toMatchObject({ category: "internal" });
			expect((error as DomainError).message).toBe("TestService.legacyOp legacy failure description");
			expect((error as DomainError).cause).toBe(rawError);
		}
	});

	test("supports customThrow as an Error instance", async () => {
		const rawError = new Error("Unique constraint violation");
		const conflict = new DomainError("conflict", "Username already exists");

		try {
			await runSafely(
				service,
				"register",
				() => {
					throw rawError;
				},
				{ customThrow: conflict },
			);
			expect.unreachable();
		} catch (error) {
			expect(error).toBe(conflict);
			expect(error).toMatchObject({ category: "conflict" });
			expect((error as DomainError).cause).toBe(rawError);
		}
	});

	test("supports customThrow as a factory function receiving the cause", async () => {
		const rawError = new Error("Foreign key violation");

		try {
			await runSafely(
				service,
				"createItem",
				() => {
					throw rawError;
				},
				{
					customThrow: (cause) => new DomainError("validation", `Invalid reference: ${(cause as Error).message}`),
				},
			);
			expect.unreachable();
		} catch (error) {
			expect(error).toMatchObject({ category: "validation" });
			expect((error as DomainError).message).toBe("Invalid reference: Foreign key violation");
			expect((error as DomainError).cause).toBe(rawError);
		}
	});
});
