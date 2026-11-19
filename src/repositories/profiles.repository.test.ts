import { expect, test } from "bun:test";
import { insertProfiles, insertUsers } from "../../tests/helpers/rows.fixture";
import { useTestDatabase } from "../../tests/helpers/test-database.helper";
import { profilesRepository } from "./profiles.repository";

const db = useTestDatabase();

test("a cached profile read started before an update does not keep the pre-update name", async () => {
	await insertUsers(db.client(), { id: "user-cache", name: "Ann", email: "ann-cache@example.test", emailVerified: true });
	await insertProfiles(db.client(), { id: "profile-cache", userId: "user-cache", name: "Ann" });

	const readStartedBeforeUpdate = profilesRepository.findByPrimaryIdCached("profile-cache");
	await profilesRepository.updateAndRead("profile-cache", { name: "Ben" });
	await readStartedBeforeUpdate;

	expect((await profilesRepository.findByPrimaryIdCached("profile-cache"))?.name).toBe("Ben");
});
