import type { ProviderEntityType } from "@reelvault/sdk/common";
import type { DatabaseTransaction, InferTable } from "@/integrations/drizzle-orm/database.types";
import { DomainError } from "@/utils/domain.errors";

/** Provider rows the sync pipeline upserts and reads back. The app registers the repository at startup. */
export interface ProviderRowsPort {
	upsertByStableKey(
		values: Array<{ stableKey: string; name: string; entityType: ProviderEntityType; externalId: string }>,
		tx?: DatabaseTransaction,
	): Promise<Array<Pick<InferTable<"providers">, "id" | "externalId">>>;
}

let providerRowsPort: ProviderRowsPort | undefined;

export function wireProviderRows(port: ProviderRowsPort): void {
	providerRowsPort = port;
}

export function providerRows(): ProviderRowsPort {
	if (!providerRowsPort) {
		throw new DomainError("internal", "Provider rows port is not wired", { code: "provider_sync.port_not_wired" });
	}

	return providerRowsPort;
}
