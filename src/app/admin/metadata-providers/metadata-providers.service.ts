import type { MetadataProviderConfiguration } from "@reelvault/sdk/common";
import { recordUpdateAudit } from "@/app/admin/admin-audit.service";
import type { AdminAuditContext } from "@/app/repositories/admin-audit.repository";
import { providerService } from "@/plugins/capabilities/provider.service";
import { DomainError } from "@/utils/domain.errors";
import type { AdminServiceState } from "../shared.utils";

export async function getMetadataProviderConfigurations(): Promise<MetadataProviderConfiguration[]> {
	return await providerService.getConfigurations();
}

export async function updateMetadataProviderConfiguration(
	state: AdminServiceState,
	providerId: string,
	values: { priority?: number; enabled?: boolean },
	context?: AdminAuditContext,
): Promise<MetadataProviderConfiguration> {
	const before = (await providerService.getConfigurations()).find((provider) => provider.id === providerId);
	if (!before) throw new DomainError("not_found", `Metadata provider not found: ${providerId}`, { code: "metadata.provider_not_found" });

	const after = await providerService.updateConfiguration(providerId, values);
	recordUpdateAudit(state.logger, {
		resourceType: "metadata_provider_configuration",
		resourceId: providerId,
		before,
		after,
		context,
	});

	return after;
}

export async function reorderMetadataProviderConfigurations(
	state: AdminServiceState,
	providerIds: string[],
	context?: AdminAuditContext,
): Promise<MetadataProviderConfiguration[]> {
	const before = await providerService.getConfigurations();
	const after = await providerService.reorderConfigurations(providerIds);
	recordUpdateAudit(state.logger, {
		resourceType: "metadata_provider_configuration_order",
		resourceId: "order",
		before,
		after,
		context,
	});

	return after;
}
