import type {
	CollectionFilters,
	CollectionSorting,
	CollectionWithRelations,
	CreateCollection,
	UpdateCollection,
} from "@sdk/common/collection.types";
import type { FieldsQuery, SelectFields } from "@sdk/common/fields";
import { auditBeforeFields, auditedUpdate, recordAuditSafe } from "@/application/admin/admin-audit.service";
import type { AdminAuditContext } from "@/database/repositories/admin-audit.repository";
import { collectionRepository } from "@/database/repositories/collections.repository";
import { ConflictError, ValidationError } from "@/utils/errors";
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
		return await this.safeExecute("create", async () => {
			await this.assertNameAvailable(body.name);
			const result = await collectionRepository.createAndRead(body, query);
			this.assertExists(result, "Collection", body.name);

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
		return await this.safeExecute("update", async () =>
			auditedUpdate({
				logger: this.logger,
				resourceType: "collection",
				resourceId: collectionId,
				entityName: "Collection",
				before: async () => {
					const snapshot = await collectionRepository.findByIdForRead(collectionId, auditBeforeFields(body, query));
					this.assertExists(snapshot, "Collection", collectionId);

					return snapshot;
				},
				update: async () => {
					let updatedBody = body;
					if (body.name !== undefined) {
						const normalizedName = body.name.trim();
						if (!normalizedName) throw new ValidationError("Collection name cannot be empty", { code: "collections.name_required" });

						updatedBody = { ...body, name: normalizedName };
						await this.assertNameAvailable(normalizedName, collectionId);
					}

					return await collectionRepository.updateAndRead(collectionId, updatedBody, query);
				},
				context,
			}),
		);
	}

	async updateManualOrder(collectionId: string, metadataIds: string[], context?: AdminAuditContext): Promise<{ success: boolean }> {
		return await this.safeExecute("updateManualOrder", async () => {
			const collection = await collectionRepository.findByIdForRead(collectionId);
			this.assertExists(collection, "Collection", collectionId);
			if (metadataIds.length === 0)
				throw new ValidationError("Manual order requires at least one metadata item", { code: "collections.items_required" });

			await collectionRepository.updateManualOrder({ collectionId, metadataIds });

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
		return await this.safeExecute("delete", async () => {
			await this.getById(collectionId, { fields: "id" });

			await collectionRepository.delete({ primaryId: collectionId });

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
			throw new ConflictError(`Collection with name "${name}" already exists`, { code: "collections.name_conflict" });
		}
	}
}

export const collectionsService = new CollectionsService();
