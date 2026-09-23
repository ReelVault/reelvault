import { describe, expect, test } from "bun:test";
import { BaseService } from "./base-service";
import { ConflictError, ForbiddenError, InternalError, NotFoundError, ValidationError } from "./errors";

class TestService extends BaseService {
	constructor(name = "TestService") {
		super(name);
	}
}

describe("BaseService", () => {
	describe("safeExecute", () => {
		test("executes async operation successfully and returns result", async () => {
			const service = new TestService();
			const result = await service.safeExecute("testOp", async () => "success");
			expect(result).toBe("success");
		});

		test("executes sync operation successfully and returns result", async () => {
			const service = new TestService();
			const result = await service.safeExecute("testSync", () => 42);
			expect(result).toBe(42);
		});

		test("re-throws DomainError as-is without wrapping in InternalError", () => {
			const service = new TestService();
			const notFound = new NotFoundError("Item not found");

			expect(
				service.safeExecute("testDomainError", () => {
					throw notFound;
				}),
			).rejects.toThrow(notFound);
		});

		test("wraps unexpected errors in InternalError with default message", async () => {
			const service = new TestService();
			const rawError = new Error("DB connection timeout");

			try {
				await service.safeExecute("testOp", () => {
					throw rawError;
				});
				expect.unreachable();
			} catch (error) {
				expect(error).toBeInstanceOf(InternalError);
				expect((error as InternalError).message).toBe("TestService.testOp failed");
				expect((error as InternalError).cause).toBe(rawError);
			}
		});

		test("supports custom errorMessage in options", async () => {
			const service = new TestService();
			const rawError = new Error("Connection reset");

			try {
				await service.safeExecute(
					"customMessageOp",
					() => {
						throw rawError;
					},
					{ errorMessage: "could not connect to database" },
				);
				expect.unreachable();
			} catch (error) {
				expect(error).toBeInstanceOf(InternalError);
				expect((error as InternalError).message).toBe("TestService.customMessageOp could not connect to database");
				expect((error as InternalError).cause).toBe(rawError);
			}
		});

		test("supports backward compatible string as 3rd argument for errorMessage", async () => {
			const service = new TestService();
			const rawError = new Error("Connection reset");

			try {
				await service.safeExecute(
					"legacyOp",
					() => {
						throw rawError;
					},
					"legacy failure description",
				);
				expect.unreachable();
			} catch (error) {
				expect(error).toBeInstanceOf(InternalError);
				expect((error as InternalError).message).toBe("TestService.legacyOp legacy failure description");
				expect((error as InternalError).cause).toBe(rawError);
			}
		});

		test("supports customThrow as an Error instance", async () => {
			const service = new TestService();
			const rawError = new Error("Unique constraint violation");
			const conflict = new ConflictError("Username already exists");

			try {
				await service.safeExecute(
					"register",
					() => {
						throw rawError;
					},
					{ customThrow: conflict },
				);
				expect.unreachable();
			} catch (error) {
				expect(error).toBe(conflict);
				expect(error).toBeInstanceOf(ConflictError);
				expect((error as ConflictError).cause).toBe(rawError);
			}
		});

		test("supports customThrow as a factory function receiving the cause", async () => {
			const service = new TestService();
			const rawError = new Error("Foreign key violation");

			try {
				await service.safeExecute(
					"createItem",
					() => {
						throw rawError;
					},
					{
						customThrow: (cause) => new ValidationError(`Invalid reference: ${(cause as Error).message}`),
					},
				);
				expect.unreachable();
			} catch (error) {
				expect(error).toBeInstanceOf(ValidationError);
				expect((error as ValidationError).message).toBe("Invalid reference: Foreign key violation");
				expect((error as ValidationError).cause).toBe(rawError);
			}
		});

		test("supports customError alias", async () => {
			const service = new TestService();
			const rawError = new Error("Access denied by OS");
			const forbidden = new ForbiddenError("Not allowed to access resource");

			try {
				await service.safeExecute(
					"checkAccess",
					() => {
						throw rawError;
					},
					{ customThrow: forbidden },
				);
				expect.unreachable();
			} catch (error) {
				expect(error).toBe(forbidden);
			}
		});
	});

	describe("assertExists", () => {
		test("does not throw when value is present", () => {
			const service = new TestService();
			expect(() => service.assertExists("hello", "String")).not.toThrow();
			expect(() => service.assertExists(0, "Number")).not.toThrow();
			expect(() => service.assertExists(false, "Boolean")).not.toThrow();
			expect(() => service.assertExists({}, "Object")).not.toThrow();
		});

		test("throws NotFoundError with entityType and entityId when value is null or undefined", () => {
			const service = new TestService();
			expect(() => service.assertExists(null, "User", "123")).toThrow(NotFoundError);
			expect(() => service.assertExists(undefined, "User", "123")).toThrow("User not found: 123");
		});

		test("throws NotFoundError with entityType only when entityId is omitted", () => {
			const service = new TestService();
			expect(() => service.assertExists(null, "User")).toThrow("User not found");
			expect(() => service.assertExists(undefined, "Session")).toThrow("Session not found");
		});
	});

	describe("assertFound", () => {
		test("does not throw when condition is true", () => {
			const service = new TestService();
			expect(() => service.assertFound(true, "MediaFile", "123")).not.toThrow();
		});

		test("throws NotFoundError when condition is false", () => {
			const service = new TestService();
			expect(() => service.assertFound(false, "MediaFile", "123")).toThrow("MediaFile not found: 123");
			expect(() => service.assertFound(false, "MediaFile")).toThrow("MediaFile not found");
		});
	});
});
