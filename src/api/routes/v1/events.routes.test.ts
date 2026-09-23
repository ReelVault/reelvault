import { expect, test } from "bun:test";
import { eventsRoutes } from "./events.routes";

test("events routes compile successfully", () => {
	expect(() => eventsRoutes.compile()).not.toThrow();
});
