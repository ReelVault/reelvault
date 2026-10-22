import { afterEach, describe, expect, test } from "bun:test";
import { env } from "@/config/env.config";
import { betterAuthApi } from "@/integrations/better-auth/better-auth.api";
import { usersRepository } from "@/repositories/users.repository";
import { insertUsers } from "../../../../tests/helpers/rows.fixture";
import { useTestDatabase } from "../../../../tests/helpers/test-database.helper";
import { firstRunSetupService } from "./first-run-setup.service";

const { client } = useTestDatabase();

const TEST_TOKEN = "test-setup-token-0123456789abcdef";

const ADMIN_INPUT = { name: "Setup Admin", email: "admin@example.com", password: "correct-horse-battery" };

// Better Auth owns the sign-up write. The stub stands in for that one call by writing the user row
// through the real table, so setup status and the administrator role are read back from the database.
const originalSignUp = betterAuthApi.signUpEmail;

afterEach(() => {
	betterAuthApi.signUpEmail = originalSignUp;
});

function stubSignUp(): void {
	betterAuthApi.signUpEmail = async (input) => {
		await insertUsers(client(), { id: "setup-user", name: input.name, email: input.email, emailVerified: true });

		return new Response(JSON.stringify({ token: null }), { status: 200 });
	};
}

async function withFlag(flag: "true" | "false", run: () => Promise<void>): Promise<void> {
	const previous = env.SETUP_TOKEN_ENABLED;
	env.SETUP_TOKEN_ENABLED = flag;

	try {
		await run();
	} finally {
		env.SETUP_TOKEN_ENABLED = previous;
	}
}

async function withToken(token: string, run: () => Promise<void>): Promise<void> {
	const previous = env.SETUP_TOKEN;
	env.SETUP_TOKEN = token;

	try {
		await run();
	} finally {
		env.SETUP_TOKEN = previous;
	}
}

describe("firstRunSetupService", () => {
	test("getStatus reports no token required by default (SETUP_TOKEN_ENABLED=false)", async () => {
		await withFlag("false", async () => {
			const status = await firstRunSetupService.getStatus();

			expect(status).toEqual({ required: true, tokenRequired: false });
		});
	});

	test("getStatus reports token required when SETUP_TOKEN_ENABLED=true", async () => {
		await withFlag("true", async () => {
			const status = await firstRunSetupService.getStatus();

			expect(status).toEqual({ required: true, tokenRequired: true });
		});
	});

	test("createAdmin completes setup without a token when disabled and makes the user an administrator", async () => {
		await withFlag("false", async () => {
			stubSignUp();

			await firstRunSetupService.createAdmin({ ...ADMIN_INPUT, token: null });

			expect(await firstRunSetupService.getStatus()).toEqual({ required: false, tokenRequired: false });
			expect((await usersRepository.findByEmail(ADMIN_INPUT.email))?.role).toBe("admin");
		});
	});

	test("createAdmin ignores a stale token header when disabled", async () => {
		await withFlag("false", async () => {
			stubSignUp();

			await firstRunSetupService.createAdmin({ ...ADMIN_INPUT, token: "garbage-token-value" });

			expect(await firstRunSetupService.getStatus()).toEqual({ required: false, tokenRequired: false });
		});
	});

	test("createAdmin refuses a wrong or missing token when enabled and leaves setup pending", async () => {
		await withFlag("true", () =>
			withToken(TEST_TOKEN, async () => {
				await expect(firstRunSetupService.createAdmin({ ...ADMIN_INPUT, token: "wrong-token-0123456789abcdef" })).rejects.toMatchObject({
					category: "forbidden",
					code: "auth.setup_token_invalid",
				});
				await expect(firstRunSetupService.createAdmin({ ...ADMIN_INPUT, token: null })).rejects.toMatchObject({
					category: "forbidden",
					code: "auth.setup_token_invalid",
				});

				expect(await firstRunSetupService.isRequired()).toBe(true);
			}),
		);
	});

	test("createAdmin accepts the correct token when enabled", async () => {
		await withFlag("true", () =>
			withToken(TEST_TOKEN, async () => {
				stubSignUp();

				await firstRunSetupService.createAdmin({ ...ADMIN_INPUT, token: TEST_TOKEN });

				expect(await firstRunSetupService.getStatus()).toEqual({ required: false, tokenRequired: true });
			}),
		);
	});

	test("createAdmin still refuses once setup is completed", async () => {
		await insertUsers(client(), { id: "existing-admin", name: "Existing", email: "existing@example.com", emailVerified: true });

		await withFlag("false", async () => {
			await expect(firstRunSetupService.createAdmin({ ...ADMIN_INPUT, token: null })).rejects.toMatchObject({
				category: "conflict",
				code: "auth.setup_completed",
			});
		});
	});
});
