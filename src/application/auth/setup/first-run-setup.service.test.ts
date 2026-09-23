import { describe, expect, test } from "bun:test";
import type { User } from "@sdk/common/user.types";
import { usersRepository } from "@/database/repositories/users.repository";
import { env } from "@/env";
import { betterAuthApi } from "@/integrations/better-auth/better-auth.api";
import { ConflictError, ForbiddenError } from "@/utils/errors";
import { firstRunSetupService } from "./first-run-setup.service";

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

function stubUserCount(count: number): () => void {
	const originalCount = usersRepository.count;
	Reflect.set(usersRepository, "count", async () => count);

	return () => {
		Reflect.set(usersRepository, "count", originalCount);
	};
}

function stubPendingSetup(): Array<() => void> {
	const restores: Array<() => void> = [stubUserCount(0)];

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
			const restoreCount = stubUserCount(0);

			try {
				const status = await firstRunSetupService.getStatus();

				expect(status).toEqual({ required: true, tokenRequired: false });
			} finally {
				restoreCount();
			}
		});
	});

	test("getStatus reports token required when SETUP_TOKEN_ENABLED=true", async () => {
		await withFlag("true", async () => {
			const restoreCount = stubUserCount(0);

			try {
				const status = await firstRunSetupService.getStatus();

				expect(status).toEqual({ required: true, tokenRequired: true });
			} finally {
				restoreCount();
			}
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
				await expect(firstRunSetupService.createAdmin({ ...ADMIN_INPUT, token: "wrong-token-0123456789abcdef" })).rejects.toThrow(
					ForbiddenError,
				);
				await expect(firstRunSetupService.createAdmin({ ...ADMIN_INPUT, token: null })).rejects.toThrow(ForbiddenError);
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
		await withFlag("false", async () => {
			const restoreCount = stubUserCount(1);

			try {
				await expect(firstRunSetupService.createAdmin({ ...ADMIN_INPUT, token: null })).rejects.toThrow(ConflictError);
			} finally {
				restoreCount();
			}
		});
	});
});
