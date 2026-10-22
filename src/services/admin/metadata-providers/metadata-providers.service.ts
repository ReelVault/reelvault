import type { MetadataProviderConfiguration } from "@reelvault/sdk/common";
import { providerService } from "@/plugins/capabilities/provider.service";
import { adminLog } from "@/services/admin/admin.logger";
import { auditedChange } from "@/services/admin/admin-audit.service";
import type { AdminAuditContext } from "@/services/admin/audit-context.types";
import { DomainError } from "@/utils/domain.errors";

export async function getMetadataProviderConfigurations(): Promise<MetadataProviderConfiguration[]> {
	return await providerService.getConfigurations();
}

export async function updateMetadataProviderConfiguration(
	providerId: string,
	values: { priority?: number; enabled?: boolean },
	context?: AdminAuditContext,
): Promise<MetadataProviderConfiguration> {
	const before = (await providerService.getConfigurations()).find((provider) => provider.id === providerId);
	if (!before) throw new DomainError("not_found", `Metadata provider not found: ${providerId}`, { code: "metadata.provider_not_found" });

	return await auditedChange({
		logger: adminLog.logger,
		resourceType: "metadata_provider_configuration",
		resourceId: providerId,
		before,
		change: async () => await providerService.updateConfiguration(providerId, values),
		context,
	});
}

export async function reorderMetadataProviderConfigurations(
	providerIds: string[],
	context?: AdminAuditContext,
): Promise<MetadataProviderConfiguration[]> {
	const before = await providerService.getConfigurations();

	return await auditedChange({
		logger: adminLog.logger,
		resourceType: "metadata_provider_configuration_order",
		resourceId: "order",
		before,
		change: async () => await providerService.reorderConfigurations(providerIds),
		context,
	});
}
