import { expect, test } from "bun:test";
import { DomainError } from "@/utils/domain.errors";
import { runBulkItems } from "./catalog.utils";

test("runs each distinct id once, in order, and reports a failure by its code, never its message", async () => {
	const ran: string[] = [];

	const outcome = await runBulkItems(
		["p1", "p2", "p1", "p3"],
		(id) => {
			ran.push(id);
			if (id === "p2") return Promise.reject(new DomainError("not_found", "Gone", { code: "catalog.not_found" }));
			if (id === "p3") return Promise.reject(new Error("/data/internal/path failed"));

			return Promise.resolve();
		},
		"person.refresh_failed",
	);

	expect(ran).toEqual(["p1", "p2", "p3"]);
	expect(outcome).toEqual({
		results: [
			{ id: "p1", ok: true },
			{ id: "p2", ok: false, code: "catalog.not_found" },
			{ id: "p3", ok: false, code: "person.refresh_failed" },
		],
	});
});
