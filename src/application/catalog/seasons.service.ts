import type { Season, SeasonFilters, SeasonSorting } from "@reelvault/sdk/common";
import { seasonsRepository } from "@/database/repositories/seasons.repository";
import { DictionaryReadService } from "./dictionary-crud.service";

class SeasonsService extends DictionaryReadService<Season, SeasonFilters, SeasonSorting, typeof seasonsRepository> {
	constructor() {
		super("SeasonsService", "Season", seasonsRepository);
	}
}

export const seasonsService = new SeasonsService();
