import type { Logger } from "@reelvault/sdk";
import type { FieldsQuery, PaginatedResponse, PaginationQuery, SelectFields } from "@reelvault/sdk/common";
import { assertFound } from "@/utils/domain.errors";
import { createLogger } from "@/utils/logger.utils";
import { runSafely } from "@/utils/safe-execute.utils";
import { invalidateCatalogLists } from "./catalog.utils";

interface DictionaryReadRepository<TEntity, TFilters, TSorting> {
	findPage<F extends string>(
		query?: PaginationQuery & FieldsQuery<F> & TFilters & TSorting,
	): Promise<PaginatedResponse<SelectFields<TEntity, F>>>;
	findByIdForRead<F extends string>(id: string, query?: FieldsQuery<F>): Promise<SelectFields<TEntity, F> | undefined>;
}

interface DictionaryCrudRepository<TEntity, TCreate extends { name: string }, TUpdate, TFilters, TSorting>
	extends DictionaryReadRepository<TEntity, TFilters, TSorting> {
	createAndRead<F extends string>(body: TCreate, query?: FieldsQuery<F>): Promise<SelectFields<TEntity, F> | undefined>;
	updateAndRead<F extends string>(id: string, body: TUpdate, query?: FieldsQuery<F>): Promise<SelectFields<TEntity, F> | undefined>;
	delete(options: { primaryId: string }): Promise<unknown>;
}

/** Read-only half of the dictionary service pair — inherited by catalog entities without a full CRUD surface. */
export abstract class DictionaryReadService<
	TEntity,
	TFilters,
	TSorting,
	TRepo extends DictionaryReadRepository<TEntity, TFilters, TSorting>,
> {
	readonly serviceName: string;
	readonly logger: Logger;
	protected readonly entityName: string;
	protected readonly repository: TRepo;

	constructor(serviceName: string, entityName: string, repository: TRepo) {
		this.serviceName = serviceName;
		this.logger = createLogger(serviceName);
		this.entityName = entityName;
		this.repository = repository;
	}

	async getAll<F extends string>(
		query?: PaginationQuery & FieldsQuery<F> & TFilters & TSorting,
	): Promise<PaginatedResponse<SelectFields<TEntity, F>>> {
		return await runSafely(this, "getAll", () => this.repository.findPage(query));
	}

	async getById<F extends string>(id: string, query?: FieldsQuery<F>): Promise<SelectFields<TEntity, F>> {
		return await runSafely(this, "getById", async () => {
			const item = await this.repository.findByIdForRead(id, query);
			assertFound(item, this.entityName, id);

			return item;
		});
	}
}

export abstract class DictionaryCrudService<
	TEntity,
	TCreate extends { name: string },
	TUpdate,
	TFilters,
	TSorting,
	TRepo extends DictionaryCrudRepository<TEntity, TCreate, TUpdate, TFilters, TSorting>,
> extends DictionaryReadService<TEntity, TFilters, TSorting, TRepo> {
	async create<F extends string>(body: TCreate, query?: FieldsQuery<F>): Promise<SelectFields<TEntity, F>> {
		return await runSafely(this, "create", async () => {
			const result = await this.repository.createAndRead(body, query);
			assertFound(result, this.entityName, body.name);
			invalidateCatalogLists();

			return result;
		});
	}

	async update<F extends string>(id: string, body: TUpdate, query?: FieldsQuery<F>): Promise<SelectFields<TEntity, F>> {
		return await runSafely(this, "update", async () => {
			const result = await this.repository.updateAndRead(id, body, query);
			assertFound(result, this.entityName, id);
			invalidateCatalogLists();

			return result;
		});
	}

	async delete(id: string): Promise<{ success: boolean }> {
		return await runSafely(this, "delete", async () => {
			// awaits: sequential — the entry must exist before it is deleted
			await this.getById(id, { fields: "id" });
			await this.repository.delete({ primaryId: id });
			invalidateCatalogLists();

			return { success: true };
		});
	}
}
