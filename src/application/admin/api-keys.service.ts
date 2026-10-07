import { createHash, randomBytes } from "node:crypto";
import type { ApiKey, ApiKeyCreated } from "@reelvault/sdk/common";
import { and, eq, gt, isNull, or } from "drizzle-orm";
import { recordAuditSafe } from "@/application/admin/admin-audit.service";
import { databaseFactory } from "@/database/database";
import type { AdminAuditContext } from "@/database/repositories/admin-audit.repository";
import { apiKeys } from "@/database/schemas/api-keys.schema";
import { users } from "@/database/schemas/auth.schema";
import { BaseService } from "@/utils/base-service";
import { NotFoundError, ValidationError } from "@/utils/errors";
import { MemoryCache } from "@/utils/memory-cache";
import { detach } from "@/utils/promise.utils";

const KEY_TAG = "rv_";
const KEY_RANDOM_BYTES = 24;
/** `last_used_at` is a diagnostics signal, not an audit trail — one write per minute is plenty. */
const LAST_USED_UPDATE_THROTTLE_MS = 60_000;
const lastUsedWriteGates = new Set<string>();
/** authenticate() runs on EVERY x-api-key request — a short-lived cache keeps the
 * hot path at zero queries while key CRUD clears it (keys are few, clear is free). */
const authenticateCache = new MemoryCache<AuthenticatedApiKey>({ ttlMs: 5_000, maxSize: 200, name: "api-keys.auth" });

export type ApiKeyScope = "read_only" | "full";

export interface AuthenticatedApiKey {
	id: string;
	scope: ApiKeyScope;
	user: {
		id: string;
		name: string;
		email: string;
		role: string;
	};
}

function hashKey(rawKey: string): string {
	return createHash("sha256").update(rawKey).digest("hex");
}

/** Anything unexpected degrades to read-only — the safe direction. */
function toScope(value: string): ApiKeyScope {
	return value === "full" ? "full" : "read_only";
}

class ApiKeysService extends BaseService {
	constructor() {
		super("ApiKeysService");
	}

	async list(): Promise<ApiKey[]> {
		const rows = await databaseFactory.getClient().select().from(apiKeys).orderBy(apiKeys.createdAt);

		return rows.map((row) => this.serialize(row));
	}

	async create(
		input: { name: string; scope: ApiKeyScope; expiresAtDays?: number | undefined; creatorUserId: string },
		context?: AdminAuditContext,
	): Promise<ApiKeyCreated> {
		const name = input.name.trim();
		if (!name) throw new ValidationError("API key name is required", { code: "api_key.name_required" });
		if (input.expiresAtDays !== undefined && (input.expiresAtDays < 1 || input.expiresAtDays > 3650)) {
			throw new ValidationError("Expiry must be between 1 and 3650 days", { code: "api_key.expiry_invalid" });
		}

		const rawKey = `${KEY_TAG}${randomBytes(KEY_RANDOM_BYTES).toString("base64url")}`;
		const keyPrefix = rawKey.slice(0, 12);
		const now = new Date();
		const expiresAt = input.expiresAtDays !== undefined ? new Date(now.getTime() + input.expiresAtDays * 86_400_000) : null;
		const id = randomBytes(12).toString("base64url");

		await databaseFactory
			.getClient()
			.insert(apiKeys)
			.values({
				id,
				name,
				keyHash: hashKey(rawKey),
				keyPrefix,
				scope: input.scope,
				createdBy: input.creatorUserId,
				expiresAt,
				createdAt: now,
				updatedAt: now,
			});

		authenticateCache.clear();
		this.logger.info("API key created", { keyId: id, scope: input.scope, expiresInDays: input.expiresAtDays ?? null });
		recordAuditSafe(
			{
				action: "create",
				resourceType: "api_key",
				resourceId: id,
				after: { name, scope: input.scope, keyPrefix },
				context,
			},
			this.logger,
		);

		// The raw key is returned exactly once — only its hash is persisted.
		return {
			id,
			name,
			keyPrefix,
			scope: input.scope,
			expiresAt: expiresAt ? expiresAt.toISOString() : null,
			lastUsedAt: null,
			createdAt: now.toISOString(),
			key: rawKey,
		};
	}

	async revoke(id: string, context?: AdminAuditContext): Promise<void> {
		const result = await databaseFactory.getClient().delete(apiKeys).where(eq(apiKeys.id, id));
		if (result.changes === 0) throw new NotFoundError("API key not found", { code: "api_key.not_found" });

		authenticateCache.clear();
		this.logger.info("API key revoked", { keyId: id });
		recordAuditSafe({ action: "delete", resourceType: "api_key", resourceId: id, context }, this.logger);
	}

	/** Resolves the owner of a presented key, or undefined when unknown or expired. */
	async authenticate(rawKey: string): Promise<AuthenticatedApiKey | undefined> {
		// One hash serves both the cache key and the stored-hash lookup.
		const keyHash = hashKey(rawKey);
		const cached = authenticateCache.get(keyHash);
		if (cached) return cached;

		const rows = await databaseFactory
			.getClient()
			.select({
				id: apiKeys.id,
				scope: apiKeys.scope,
				userId: users.id,
				userName: users.name,
				userEmail: users.email,
				userRole: users.role,
			})
			.from(apiKeys)
			.innerJoin(users, eq(users.id, apiKeys.createdBy))
			.where(and(eq(apiKeys.keyHash, keyHash), or(isNull(apiKeys.expiresAt), gt(apiKeys.expiresAt, new Date()))))
			.limit(1);

		const row = rows[0];
		if (!row) return undefined;

		this.touchLastUsed(row.id);

		const authenticated: AuthenticatedApiKey = {
			id: row.id,
			scope: toScope(row.scope),
			user: { id: row.userId, name: row.userName, email: row.userEmail, role: row.userRole },
		};
		authenticateCache.set(keyHash, authenticated);

		return authenticated;
	}

	private touchLastUsed(keyId: string): void {
		if (lastUsedWriteGates.has(keyId)) return;

		lastUsedWriteGates.add(keyId);
		detach(
			(async () => {
				try {
					await databaseFactory.getClient().update(apiKeys).set({ lastUsedAt: new Date() }).where(eq(apiKeys.id, keyId));
				} catch (error) {
					this.logger.warn("Failed to refresh API key last-used timestamp", { keyId, error });
				} finally {
					setTimeout(() => lastUsedWriteGates.delete(keyId), LAST_USED_UPDATE_THROTTLE_MS);
				}
			})(),
		);
	}

	private serialize(row: typeof apiKeys.$inferSelect): ApiKey {
		return {
			id: row.id,
			name: row.name,
			keyPrefix: row.keyPrefix,
			scope: toScope(row.scope),
			expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
			lastUsedAt: row.lastUsedAt ? row.lastUsedAt.toISOString() : null,
			createdAt: row.createdAt.toISOString(),
		};
	}
}

export const apiKeysService = new ApiKeysService();
