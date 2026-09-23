import type {
	FieldsQuery,
	PaginatedResponse,
	PaginationQuery,
	Season,
	SeasonFilters,
	SeasonSorting,
	SelectFields,
} from "@reelvault/sdk/common";
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
