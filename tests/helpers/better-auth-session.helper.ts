import { auth } from "@/integrations/better-auth/better-auth.config";
import { type MethodStub, stubMethod } from "./method-stub.helper";

const SIGNED_IN_AT = new Date("2026-01-02T03:04:05.000Z");

/**
 * Makes better-auth report `userId` as the signed-in user for the rest of the test. Push the returned stub into the
 * file's `stubs` list and restore it in `afterEach`.
 */
export function stubSignedInSession(userId: string, role = "user"): MethodStub {
	return stubMethod(auth.api, "getSession", async () => ({
		user: {
			id: userId,
			name: "User",
			email: `${userId}@example.com`,
			emailVerified: true,
			image: null,
			createdAt: SIGNED_IN_AT,
			updatedAt: SIGNED_IN_AT,
			role,
			twoFactorEnabled: false,
			banned: false,
		},
		session: {
			id: `${userId}-session`,
			userId,
			expiresAt: new Date("2099-01-02T03:04:05.000Z"),
			createdAt: SIGNED_IN_AT,
			updatedAt: SIGNED_IN_AT,
		},
	}));
}
