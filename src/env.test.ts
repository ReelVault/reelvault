import { expect, test } from "bun:test";
import { describeEnvIssues } from "./env";

test("describeEnvIssues lists one line per invalid variable with a fix hint", () => {
	const message = describeEnvIssues([
		{ path: ["APP_PORT"], message: "Invalid input: expected number, received NaN" },
		{ path: [], message: "Something general" },
	]);

	expect(message).toContain("  - APP_PORT: Invalid input: expected number, received NaN");
	expect(message).toContain("  - (root): Something general");
	expect(message).toContain(".env");
});
