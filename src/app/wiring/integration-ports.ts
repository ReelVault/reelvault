import { profilesRepository } from "@/app/repositories/profiles.repository";
import { providersRepository } from "@/app/repositories/providers.repository";
import { wireAuthUserCreated } from "@/integrations/better-auth/better-auth.ports";
import { wireProviderRows } from "@/integrations/drizzle-orm/utils/provider-entity-sync.ports";

/** Hands the integrations their app-side collaborators. Called at startup, before any user or provider write. */
export function wireIntegrationPorts(): void {
	wireAuthUserCreated({
		onUserCreated: async (user) => {
			await profilesRepository.insert({
				values: {
					userId: user.id,
					name: user.name,
				},
			});
		},
	});
	wireProviderRows({
		upsertByStableKey: async (values, tx) => await providersRepository.upsertByStableKey(values, tx),
	});
}
