import type { BulkRefreshItem, CreatePerson, PersonFilters, PersonSorting, PersonWithRelations, UpdatePerson } from "@reelvault/sdk/common";
import { peopleRepository } from "@/app/repositories/people.repository";
import { imageProcessingService } from "@/modules/images/image-processing.service";
import { providerService } from "@/plugins/capabilities/provider.service";
import { assertFound } from "@/utils/domain.errors";
import { runSafely } from "@/utils/safe-execute.utils";
import { findFirstProviderResult, invalidateCatalogLists, runBulkItem } from "./catalog.utils";
import { DictionaryCrudService } from "./dictionary-crud.service";

class PeopleService extends DictionaryCrudService<
	PersonWithRelations,
	CreatePerson,
	UpdatePerson,
	PersonFilters,
	PersonSorting,
	typeof peopleRepository
> {
	constructor() {
		super("PeopleService", "Person", peopleRepository);
	}

	async refresh(personId: string, options: { forceImage?: boolean } = {}) {
		return await runSafely(this, "refresh", async () => {
			const person = await peopleRepository.findByIdRaw(personId);
			assertFound(person, "Person", personId);

			const providerLink = await peopleRepository.findFirstProviderLink(personId);
			const externalId = providerLink?.externalId;
			if (externalId) {
				const providerPerson = await providerService.fetchPerson(externalId);
				const match = findFirstProviderResult(providerPerson);

				if (match) {
					await peopleRepository.update({
						primaryId: person.id,
						values: {
							name: match.name || person.name,
							biography: match.biography ?? person.biography,
							birthday: match.birthday ?? person.birthday,
							gender: match.gender ?? person.gender,
							popularity: match.popularity ?? person.popularity,
						},
					});

					if (match.profilePath) {
						if (options.forceImage || !person.imageId) {
							await imageProcessingService.processPerson(person.id, match.profilePath, options.forceImage);
						}
					}
				}
			}

			invalidateCatalogLists();

			return await this.getById(personId);
		});
	}

	async refreshImage(personId: string) {
		return await this.refresh(personId, { forceImage: true });
	}

	/** Refreshes the listed people one after another, so provider calls stay sequential; each id reports its own outcome. */
	async refreshMany(personIds: string[]) {
		return await runSafely(this, "refreshMany", async () => {
			const results: BulkRefreshItem[] = [];
			for (const personId of new Set(personIds)) {
				results.push(await runBulkItem(personId, () => this.refresh(personId), "person.refresh_failed"));
			}

			return { results };
		});
	}
}

export const peopleService = new PeopleService();
