import type { FieldsQuery, SelectFields } from "@sdk/common/fields";
import type { PaginatedResponse, PaginationQuery } from "@sdk/common/pagination";
import type { Season, SeasonFilters, SeasonSorting } from "@sdk/common/season.types";
import { seasonsRepository } from "@/database/repositories/seasons.repository";
import { BaseService } from "@/utils/base-service";

class SeasonsService extends BaseService {
	constructor() {
		super("SeasonsService");
	}

	async getAll<F extends string>(
		query?: PaginationQuery & FieldsQuery<F> & SeasonFilters & SeasonSorting,
	): Promise<PaginatedResponse<SelectFields<Season, F>>> {
		return await this.safeExecute("getAll", () => seasonsRepository.findPage(query));
	}

	async getById<F extends string>(seasonId: string, query?: FieldsQuery<F>): Promise<SelectFields<Season, F>> {
		return await this.safeExecute("getById", async () => {
			const media = await seasonsRepository.findByIdForRead(seasonId, query);
			this.assertExists(media, "Season", seasonId);

			return media;
		});
	}
}

export const seasonsService = new SeasonsService();
