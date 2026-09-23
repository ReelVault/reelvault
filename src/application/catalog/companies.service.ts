import type { Company, CompanyFilters, CompanySorting, CreateCompany, Metadata, UpdateCompany } from "@reelvault/sdk/common";
import { companiesRepository } from "@/database/repositories/companies.repository";
import { clamp } from "@/utils/math.utils";
import { DictionaryCrudService } from "./dictionary-crud.service";

class CompaniesService extends DictionaryCrudService<
	Company,
	CreateCompany,
	UpdateCompany,
	CompanyFilters,
	CompanySorting,
	typeof companiesRepository
> {
	constructor() {
		super("CompaniesService", "Company", companiesRepository);
	}

	async getMetadata(companyId: string, limit = 100): Promise<Metadata[]> {
		return await this.safeExecute("getMetadata", async () => {
			await this.getById(companyId, { fields: "id" });

			return await this.repository.findMetadata({
				companyId,
				limit: clamp(limit, 1, 100),
			});
		});
	}
}

export const companiesService = new CompaniesService();
