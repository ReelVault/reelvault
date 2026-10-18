import { afterEach, describe, expect, test } from "bun:test";
import { librariesRepository } from "@/app/repositories/libraries.repository";
import { workerService } from "@/workers/worker.service";
import { type MethodStub, stubMethod } from "../../../tests/helpers/method-stub.helper";
import { librariesService } from "./libraries.service";

const stubs: MethodStub[] = [];

afterEach(() => {
	for (const stub of stubs.splice(0)) stub.restore();
});

describe("cancel scans", () => {
	test("cancels each active operation of the library's scans once, including catch-up passes", async () => {
		const looked: string[][] = [];
		const cancelled: string[] = [];
		stubs.push(
			stubMethod(librariesRepository, "findByIdForRead", async () => ({ id: "lib-1", paths: [{ id: "p1" }] })),
			stubMethod(workerService, "findActiveItems", (_workerId: string, dedupeKeys: readonly string[]) => {
				looked.push([...dedupeKeys]);

				return Promise.resolve([{ operationId: "op-a" }, { operationId: null }, { operationId: "op-a" }, { operationId: "op-b" }]);
			}),
			stubMethod(workerService, "cancelOperation", (operationId: string) => {
				cancelled.push(operationId);

				return Promise.resolve(true);
			}),
		);

		const result = await librariesService.cancelScans("lib-1");

		expect(looked).toEqual([["lib-1:all", "lib-1:all:catch-up", "lib-1:p1", "lib-1:p1:catch-up"]]);
		expect(cancelled).toEqual(["op-a", "op-b"]);
		expect(result).toEqual({ cancelled: 2 });
	});
});
