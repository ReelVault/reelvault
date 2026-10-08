import { and, eq } from "drizzle-orm";
import { databaseFactory } from "@/database/database";
import { schema } from "@/database/schema";

const CREDENTIAL_PROVIDER = "credential";

/** Email/password login data (better-auth `account` and `twoFactor` rows) for account recovery. */
class CredentialsRepository {
	/** Replaces the stored password hash of a user's email/password login. Returns whether such a login exists. */
	async setPasswordHash(userId: string, passwordHash: string): Promise<boolean> {
		const updated = await databaseFactory
			.getClient()
			.update(schema.accounts)
			.set({ password: passwordHash, updatedAt: new Date() })
			.where(and(eq(schema.accounts.userId, userId), eq(schema.accounts.providerId, CREDENTIAL_PROVIDER)))
			.returning({ id: schema.accounts.id });

		return updated.length > 0;
	}

	/** Removes the user's TOTP secret and backup codes and turns two-factor off. */
	async clearTwoFactor(userId: string): Promise<void> {
		await databaseFactory.transaction(async (tx) => {
			await tx.delete(schema.twoFactors).where(eq(schema.twoFactors.userId, userId));
			await tx.update(schema.users).set({ twoFactorEnabled: false, updatedAt: new Date() }).where(eq(schema.users.id, userId));
		});
	}
}

export const credentialsRepository = new CredentialsRepository();
