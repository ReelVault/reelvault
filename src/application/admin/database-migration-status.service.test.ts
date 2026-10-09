import { afterEach, describe, expect, test } from "bun:test";
import { databaseMaintenanceRepository } from "@/database/repositories/database-maintenance.repository";
import { stubMethod } from "../../../tests/helpers/method-stub";
import { databaseMaintenanceService } from "./database-maintenance.service";

const stubs: Array<{ restore(): void }> = [];

afterEach(() => {
	for (const stub of stubs.splice(0)) stub.restore();
});

describe("DatabaseMaintenanceService.getMigrationStatus", () => {
	test("counts the applied migrations and lists every one in order", async () => {
		stubs.push(
			stubMethod(databaseMaintenanceRepository, "getMigrationStatus", () => ({ tags: ["a_init", "b_add", "c_more"], applied: 2 })),
		);

		expect(await databaseMaintenanceService.getMigrationStatus()).toEqual({
			total: 3,
			applied: 2,
			pending: 1,
			latest: "b_add",
			migrations: [
				{ tag: "a_init", applied: true },
				{ tag: "b_add", applied: true },
				{ tag: "c_more", applied: false },
			],
		});
	});

	test("reports nothing applied before the first migration is recorded", async () => {
		stubs.push(stubMethod(databaseMaintenanceRepository, "getMigrationStatus", () => ({ tags: ["a_init"], applied: 0 })));

		expect(await databaseMaintenanceService.getMigrationStatus()).toMatchObject({ applied: 0, pending: 1, latest: null });
	});
});
