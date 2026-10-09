import { afterEach, describe, expect, test } from "bun:test";
import { usersRepository } from "@/database/repositories/users.repository";
import { stubMethod } from "../../../tests/helpers/method-stub";
import { adminUsersService } from "./admin-users.service";

const stubs: Array<{ restore(): void }> = [];

afterEach(() => {
	for (const stub of stubs.splice(0)) stub.restore();
});

function stubFindForAdministration() {
	const findForAdministration = stubMethod(usersRepository, "findForAdministration", () => Promise.resolve({ total: 0, data: [] }));
	stubs.push(findForAdministration);

	return findForAdministration;
}

describe("AdminUsersService.getAll filters", () => {
	test("passes the role and maps the blocked status to banned accounts", async () => {
		const findForAdministration = stubFindForAdministration();

		await adminUsersService.getAll({ q: " ada ", role: "admin", status: "blocked" });

		expect(findForAdministration.calls).toEqual([[expect.objectContaining({ search: "ada", role: "admin", banned: true })]]);
	});

	test("maps the active status to accounts that are not banned", async () => {
		const findForAdministration = stubFindForAdministration();

		await adminUsersService.getAll({ status: "active" });

		expect(findForAdministration.calls).toEqual([[expect.objectContaining({ role: undefined, banned: false })]]);
	});

	test("leaves the role and status unfiltered when they are not given", async () => {
		const findForAdministration = stubFindForAdministration();

		await adminUsersService.getAll({});

		expect(findForAdministration.calls).toEqual([[expect.objectContaining({ role: undefined, banned: undefined })]]);
	});
});
