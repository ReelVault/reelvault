import { expect, test } from "bun:test";
import { meRoutes } from "./me.routes";

test("me routes compile as a single profile-owned resource group", () => {
	expect(() => meRoutes.compile()).not.toThrow();
});
