import type {
	CollectionFilters,
	CollectionSorting,
	CollectionWithRelations,
	CreateCollection,
	FieldsQuery,
	SelectFields,
	UpdateCollection,
} from "@reelvault/sdk/common";
import { auditBeforeFields, auditedUpdate, recordAuditSafe } from "@/application/admin/admin-audit.service";
import type { AdminAuditContext } from "@/database/repositories/admin-audit.repository";
import { collectionRepository } from "@/database/repositories/collections.repository";
import { assertFound, DomainError } from "@/utils/errors";
import { runSafely } from "@/utils/safe-execute";
import { invalidateCatalogLists } from "./catalog.utils";
import { DictionaryCrudService } from "./dictionary-crud.service";

class CollectionsService extends DictionaryCrudService<
	CollectionWithRelations,
	CreateCollection,
	UpdateCollection,
	CollectionFilters,
	CollectionSorting,
	typeof collectionRepository
> {
	constructor() {
		super("CollectionsService", "Collection", collectionRepository);
	}

	override async create<F extends string>(
		body: CreateCollection,
		query?: FieldsQuery<F>,
		context?: AdminAuditContext,
	): Promise<SelectFields<CollectionWithRelations, F>> {
		return await runSafely(this, "create", async () => {
			await this.assertNameAvailable(body.name);
			const result = await collectionRepository.createAndRead(body, query);
			assertFound(result, "Collection", body.name);
			invalidateCatalogLists();

			recordAuditSafe(
				{
					action: "create",
					resourceType: "collection",
					resourceId: result.id,
					after: result,
					context,
				},
				this.logger,
			);

			return result;
		});
	}

	override async update<F extends string>(
		collectionId: string,
		body: UpdateCollection,
		query?: FieldsQuery<F>,
		context?: AdminAuditContext,
	): Promise<SelectFields<CollectionWithRelations, F>> {
		return await runSafely(this, "update", async () =>
			auditedUpdate({
				logger: this.logger,
				resourceType: "collection",
				resourceId: collectionId,
				entityName: "Collection",
				before: async () => {
					const snapshot = await collectionRepository.findByIdForRead(collectionId, auditBeforeFields(body, query));
					assertFound(snapshot, "Collection", collectionId);

					return snapshot;
				},
				update: async () => {
					let updatedBody = body;
					if (body.name !== undefined) {
						const normalizedName = body.name.trim();
						if (!normalizedName)
							throw new DomainError("validation", "Collection name cannot be empty", { code: "collections.name_required" });

						updatedBody = { ...body, name: normalizedName };
						await this.assertNameAvailable(normalizedName, collectionId);
					}

					return await collectionRepository.updateAndRead(collectionId, updatedBody, query);
				},
				afterUpdate: () => invalidateCatalogLists(),
				context,
			}),
		);
	}

	async updateManualOrder(collectionId: string, metadataIds: string[], context?: AdminAuditContext): Promise<{ success: boolean }> {
		return await runSafely(this, "updateManualOrder", async () => {
			const collection = await collectionRepository.findByIdForRead(collectionId);
			assertFound(collection, "Collection", collectionId);
			if (metadataIds.length === 0)
				throw new DomainError("validation", "Manual order requires at least one metadata item", { code: "collections.items_required" });

			await collectionRepository.updateManualOrder({ collectionId, metadataIds });
			invalidateCatalogLists();

			recordAuditSafe(
				{
					action: "update",
					resourceType: "collection_order",
					resourceId: collectionId,
					after: { metadataIds },
					context,
				},
				this.logger,
			);

			return { success: true };
		});
	}

	override async delete(collectionId: string, context?: AdminAuditContext): Promise<{ success: boolean }> {
		return await runSafely(this, "delete", async () => {
			await this.getById(collectionId, { fields: "id" });

			await collectionRepository.delete({ primaryId: collectionId });
			invalidateCatalogLists();

			recordAuditSafe(
				{
					action: "delete",
					resourceType: "collection",
					resourceId: collectionId,
					context,
				},
				this.logger,
			);

			return { success: true };
		});
	}

	private async assertNameAvailable(name: string, excludeId?: string): Promise<void> {
		const existing = await collectionRepository.findByName(name);
		if (existing && existing.id !== excludeId) {
			throw new DomainError("conflict", `Collection with name "${name}" already exists`, { code: "collections.name_conflict" });
		}
	}
}

export const collectionsService = new CollectionsService();
