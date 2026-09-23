import type { CreatePerson, PersonFilters, PersonSorting, PersonWithRelations, UpdatePerson } from "@reelvault/sdk/common";
import { pluginsService } from "@/application/plugins.service";
import { peopleRepository } from "@/database/repositories/people.repository";
import { imageProcessingService } from "@/modules/images/image-processing.service";
import { findFirstProviderResult } from "./catalog.utils";
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
		return await this.safeExecute("refresh", async () => {
			const person = await peopleRepository.findByIdRaw(personId);
			this.assertExists(person, "Person", personId);

			const providerLink = await peopleRepository.findFirstProviderLink(personId);
			const externalId = providerLink?.externalId;
			if (externalId) {
				const providerPerson = await pluginsService.fetchProviderPerson(externalId);
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

			return await this.getById(personId);
		});
	}

	async refreshImage(personId: string) {
		return await this.refresh(personId, { forceImage: true });
	}
}

export const peopleService = new PeopleService();
