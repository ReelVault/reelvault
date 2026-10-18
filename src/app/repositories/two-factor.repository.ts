import { eq } from "drizzle-orm";
import { databaseFactory } from "@/integrations/drizzle-orm/database.factory";
import { schema } from "@/integrations/drizzle-orm/database.schema";

/** Second-factor records written by the auth plugin. Read only for the backup code count. */
export const twoFactorRepository = {
	/** The encrypted backup code list of an account, or `null` when the account has no second-factor record. */
	async findEncryptedBackupCodes(userId: string): Promise<string | null> {
		const [row] = await databaseFactory
			.getClient()
			.select({ backupCodes: schema.twoFactors.backupCodes })
			.from(schema.twoFactors)
			.where(eq(schema.twoFactors.userId, userId))
			.limit(1);

		return row?.backupCodes ?? null;
	},
};
