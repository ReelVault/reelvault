import type { Company, CompanyFilters, CompanySorting, CreateCompany, Metadata, UpdateCompany } from "@reelvault/sdk/common";
import { companiesRepository } from "@/repositories/companies.repository";
import { clamp } from "@/utils/math.utils";
import { runSafely } from "@/utils/safe-execute.utils";
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
		return await runSafely(this, "getMetadata", async () => {
			await this.getById(companyId, { fields: "id" });

			return await this.repository.findMetadata({
				companyId,
				limit: clamp(limit, 1, 100),
			});
		});
	}
}

export const companiesService = new CompaniesService();
