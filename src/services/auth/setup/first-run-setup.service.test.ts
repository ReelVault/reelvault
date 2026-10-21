import { describe, expect, test } from "bun:test";
import type { User } from "@reelvault/sdk/common";
import { env } from "@/config/env.config";
import { betterAuthApi } from "@/integrations/better-auth/better-auth.api";
import { usersRepository } from "@/repositories/users.repository";
import { insertUsers } from "../../../../tests/helpers/rows.fixture";
import { useTestDatabase } from "../../../../tests/helpers/test-database.helper";
import { firstRunSetupService } from "./first-run-setup.service";

const { client } = useTestDatabase();

const TEST_TOKEN = "test-setup-token-0123456789abcdef";

const mockUser: User = {
	id: "setup-user-123",
	name: "Setup Admin",
	email: "admin@example.com",
	emailVerified: true,
	image: null,
	role: "user",
	twoFactorEnabled: false,
	banned: false,
	banReason: null,
	banExpires: null,
	createdAt: new Date(),
	updatedAt: new Date(),
};

const ADMIN_INPUT = { name: "Setup Admin", email: "admin@example.com", password: "correct-horse-battery" };

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

// The database starts with no users, so setup is pending. The sign-up, lookup and promotion calls
// below stand in for Better Auth's sign-up flow; the user count is the real table.
function stubPendingSetup(): Array<() => void> {
	const restores: Array<() => void> = [];

	const originalFindByEmail = usersRepository.findByEmail;
	usersRepository.findByEmail = async () => mockUser;
	restores.push(() => {
		usersRepository.findByEmail = originalFindByEmail;
	});

	const originalPromote = usersRepository.promoteToAdmin;
	usersRepository.promoteToAdmin = async () => undefined;
	restores.push(() => {
		usersRepository.promoteToAdmin = originalPromote;
	});

	const originalSignUp = betterAuthApi.signUpEmail;
	betterAuthApi.signUpEmail = async () => new Response(JSON.stringify({ token: null, user: mockUser }), { status: 200 });
	restores.push(() => {
		betterAuthApi.signUpEmail = originalSignUp;
	});

	return restores;
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

	test("createAdmin completes setup without a token when disabled", async () => {
		await withFlag("false", async () => {
			const restores = stubPendingSetup();

			try {
				const response = await firstRunSetupService.createAdmin({ ...ADMIN_INPUT, token: null });

				expect(response.ok).toBe(true);
			} finally {
				for (const restore of restores) restore();
			}
		});
	});

	test("createAdmin ignores a stale token header when disabled", async () => {
		await withFlag("false", async () => {
			const restores = stubPendingSetup();

			try {
				const response = await firstRunSetupService.createAdmin({ ...ADMIN_INPUT, token: "garbage-token-value" });

				expect(response.ok).toBe(true);
			} finally {
				for (const restore of restores) restore();
			}
		});
	});

	test("createAdmin rejects a wrong or missing token when enabled", async () => {
		await withFlag("true", () =>
			withToken(TEST_TOKEN, async () => {
				await expect(firstRunSetupService.createAdmin({ ...ADMIN_INPUT, token: "wrong-token-0123456789abcdef" })).rejects.toMatchObject({
					category: "forbidden",
				});
				await expect(firstRunSetupService.createAdmin({ ...ADMIN_INPUT, token: null })).rejects.toMatchObject({ category: "forbidden" });
			}),
		);
	});

	test("createAdmin accepts the correct token when enabled", async () => {
		await withFlag("true", () =>
			withToken(TEST_TOKEN, async () => {
				const restores = stubPendingSetup();

				try {
					const response = await firstRunSetupService.createAdmin({ ...ADMIN_INPUT, token: TEST_TOKEN });

					expect(response.ok).toBe(true);
				} finally {
					for (const restore of restores) restore();
				}
			}),
		);
	});

	test("createAdmin still refuses once setup is completed", async () => {
		await insertUsers(client(), { id: "existing-admin", name: "Existing", email: "existing@example.com", emailVerified: true });

		await withFlag("false", async () => {
			await expect(firstRunSetupService.createAdmin({ ...ADMIN_INPUT, token: null })).rejects.toMatchObject({ category: "conflict" });
		});
	});
});
