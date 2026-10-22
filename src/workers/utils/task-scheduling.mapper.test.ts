import { describe, expect, test } from "bun:test";
import { toTaskSchedulingOptions } from "./task-scheduling.mapper";

describe("toTaskSchedulingOptions", () => {
	test("returns empty options without an operationId", () => {
		expect(toTaskSchedulingOptions({})).toStrictEqual({});
		expect(toTaskSchedulingOptions({ operationId: undefined, taskId: "task-1" })).toStrictEqual({});
	});

	test("chains the taskId when the operation and task are present", () => {
		expect(toTaskSchedulingOptions({ operationId: "op-1", taskId: "task-1" })).toEqual({
			operationId: "op-1",
			dependsOnTaskIds: ["task-1"],
		});
	});

	test("leaves dependsOnTaskIds undefined when only the operation is known", () => {
		const options = toTaskSchedulingOptions({ operationId: "op-1" });

		expect(options).toMatchObject({ operationId: "op-1" });
		expect(options.dependsOnTaskIds).toBeUndefined();
	});
});
