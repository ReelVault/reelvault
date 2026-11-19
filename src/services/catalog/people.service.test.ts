import { afterEach, describe, expect, test } from "bun:test";
import { providerService } from "@/plugins/capabilities/provider.service";
import { peopleRepository } from "@/repositories/people.repository";
import { type MethodStub, stubMethod } from "../../../tests/helpers/method-stub.helper";
import { insertPeople, selectPeople } from "../../../tests/helpers/rows.fixture";
import { useTestDatabase } from "../../../tests/helpers/test-database.helper";
import { peopleService } from "./people.service";

const { client } = useTestDatabase();
const stubs: MethodStub[] = [];

afterEach(() => {
	for (const stub of stubs.splice(0).toReversed()) stub.restore();
});

describe("peopleService.refresh", () => {
	test("keeps the stored name when the provider returns an empty name, and takes the other fields", async () => {
		await insertPeople(client(), { id: "p1", stableKey: "person:ann", name: "Ann", biography: "Old bio" });
		stubs.push(
			stubMethod(peopleRepository, "findFirstProviderLink", () => Promise.resolve({ externalId: "42", name: "Ann" })),
			stubMethod(providerService, "fetchPerson", () =>
				Promise.resolve([{ metadata: { name: "", biography: "New bio", birthday: null, gender: null, popularity: 3.5 } }]),
			),
		);

		await peopleService.refresh("p1");

		const [person] = await selectPeople(client());
		expect(person).toMatchObject({ name: "Ann", biography: "New bio", popularity: 3.5 });
	});
});
