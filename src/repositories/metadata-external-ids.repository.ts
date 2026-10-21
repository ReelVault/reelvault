import type { ExternalIdentifiers } from "@reelvault/sdk/plugin";
import { eq } from "drizzle-orm";
import { databaseFactory } from "@/integrations/drizzle-orm/database.factory";
import { schema } from "@/integrations/drizzle-orm/database.schema";
import type { DatabaseTransaction } from "@/integrations/drizzle-orm/database.types";
import { isNonEmptyString } from "@/utils/type.utils";

export const metadataExternalIdsRepository = {
	async replace(metadataId: string, identifiers: ExternalIdentifiers, tx?: DatabaseTransaction): Promise<void> {
		const client = databaseFactory.getClient({ tx });
		await client.delete(schema.metadataExternalIds).where(eq(schema.metadataExternalIds.metadataId, metadataId));
		const values = Object.entries(identifiers)
			.filter(([identifierType, identifier]) => isNonEmptyString(identifierType) && isNonEmptyString(identifier))
			.map(([identifierType, identifier]) => ({ metadataId, identifierType: identifierType.trim(), identifier: identifier.trim() }));
		if (values.length > 0) await client.insert(schema.metadataExternalIds).values(values);
	},
};
