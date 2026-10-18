import { databaseFactory } from "@/integrations/drizzle-orm/database.factory";
import type { DatabaseTransaction } from "@/integrations/drizzle-orm/database.types";

export type { DatabaseTransaction };

/** Runs several repository writes in one transaction, for services that must not depend on the database factory. */
export class UnitOfWorkRepository {
	async run<T>(work: (tx: DatabaseTransaction) => Promise<T>): Promise<T> {
		return await databaseFactory.transaction(work);
	}
}

export const unitOfWorkRepository = new UnitOfWorkRepository();
