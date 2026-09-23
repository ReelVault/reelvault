import type { ExternalIdentifiers } from "@sdk/plugin";
import { eq } from "drizzle-orm";
import { databaseFactory } from "@/database/database";
import { schema } from "@/database/schema";
import type { DatabaseTransaction } from "@/database/types";
import { isNonEmptyString } from "@/utils/type.utils";

class MetadataExternalIdsRepository {
	async replace(metadataId: string, identifiers: ExternalIdentifiers, tx?: DatabaseTransaction): Promise<void> {
		const client = databaseFactory.getClient({ tx });
		await client.delete(schema.metadataExternalIds).where(eq(schema.metadataExternalIds.metadataId, metadataId));
		const values = Object.entries(identifiers)
			.filter(([identifierType, identifier]) => isNonEmptyString(identifierType) && isNonEmptyString(identifier))
			.map(([identifierType, identifier]) => ({ metadataId, identifierType: identifierType.trim(), identifier: identifier.trim() }));
		if (values.length > 0) await client.insert(schema.metadataExternalIds).values(values);
	}
}

export const metadataExternalIdsRepository = new MetadataExternalIdsRepository();
