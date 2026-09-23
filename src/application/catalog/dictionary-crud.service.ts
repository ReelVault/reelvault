import type { FieldsQuery, SelectFields } from "@sdk/common/fields";
import type { PaginatedResponse, PaginationQuery } from "@sdk/common/pagination";
import { BaseService } from "@/utils/base-service";

interface DictionaryCrudRepository<TEntity, TCreate extends { name: string }, TUpdate, TFilters, TSorting> {
	findPage<F extends string>(
		query?: PaginationQuery & FieldsQuery<F> & TFilters & TSorting,
	): Promise<PaginatedResponse<SelectFields<TEntity, F>>>;
	findByIdForRead<F extends string>(id: string, query?: FieldsQuery<F>): Promise<SelectFields<TEntity, F> | undefined>;
	createAndRead<F extends string>(body: TCreate, query?: FieldsQuery<F>): Promise<SelectFields<TEntity, F> | undefined>;
	updateAndRead<F extends string>(id: string, body: TUpdate, query?: FieldsQuery<F>): Promise<SelectFields<TEntity, F> | undefined>;
	delete(options: { primaryId: string }): Promise<unknown>;
}

export abstract class DictionaryCrudService<
	TEntity,
	TCreate extends { name: string },
	TUpdate,
	TFilters,
	TSorting,
	TRepo extends DictionaryCrudRepository<TEntity, TCreate, TUpdate, TFilters, TSorting>,
> extends BaseService {
	protected readonly entityName: string;
	protected readonly repository: TRepo;

	constructor(serviceName: string, entityName: string, repository: TRepo) {
		super(serviceName);
		this.entityName = entityName;
		this.repository = repository;
	}

	async getAll<F extends string>(
		query?: PaginationQuery & FieldsQuery<F> & TFilters & TSorting,
	): Promise<PaginatedResponse<SelectFields<TEntity, F>>> {
		return await this.safeExecute("getAll", () => this.repository.findPage(query));
	}

	async getById<F extends string>(id: string, query?: FieldsQuery<F>): Promise<SelectFields<TEntity, F>> {
		return await this.safeExecute("getById", async () => {
			const item = await this.repository.findByIdForRead(id, query);
			this.assertExists(item, this.entityName, id);

			return item;
		});
	}

	async create<F extends string>(body: TCreate, query?: FieldsQuery<F>): Promise<SelectFields<TEntity, F>> {
		return await this.safeExecute("create", async () => {
			const result = await this.repository.createAndRead(body, query);
			this.assertExists(result, this.entityName, body.name);

			return result;
		});
	}

	async update<F extends string>(id: string, body: TUpdate, query?: FieldsQuery<F>): Promise<SelectFields<TEntity, F>> {
		return await this.safeExecute("update", async () => {
			const result = await this.repository.updateAndRead(id, body, query);
			this.assertExists(result, this.entityName, id);

			return result;
		});
	}

	async delete(id: string): Promise<{ success: boolean }> {
		return await this.safeExecute("delete", async () => {
			await this.getById(id, { fields: "id" });
			await this.repository.delete({ primaryId: id });

			return { success: true };
		});
	}
}
