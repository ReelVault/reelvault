import type { CreateKeyword, Keyword, KeywordFilters, KeywordSorting, UpdateKeyword } from "@sdk/common/keyword.types";
import { keywordsRepository } from "@/database/repositories/keywords.repository";
import { DictionaryCrudService } from "./dictionary-crud.service";

class KeywordsService extends DictionaryCrudService<
	Keyword,
	CreateKeyword,
	UpdateKeyword,
	KeywordFilters,
	KeywordSorting,
	typeof keywordsRepository
> {
	constructor() {
		super("KeywordsService", "Keyword", keywordsRepository);
	}
}

export const keywordsService = new KeywordsService();
