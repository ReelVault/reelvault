import { createHash, randomBytes } from "node:crypto";
import type { ApiKey, ApiKeyCreated } from "@reelvault/sdk/common";
import { type ApiKeyChanges, type ApiKeyRow, apiKeysRepository } from "@/repositories/api-keys.repository";
import { recordAuditSafe } from "@/services/admin/admin-audit.service";
import type { AdminAuditContext } from "@/services/admin/audit-context.types";
import { DomainError } from "@/utils/domain.errors";
import { createLogger } from "@/utils/logger.utils";
import { MemoryCache } from "@/utils/memory.cache";
import { detach } from "@/utils/promise.utils";
import { isNullish } from "@/utils/type.utils";

const KEY_TAG = "rv_";
const KEY_RANDOM_BYTES = 24;
/** `last_used_at` is a diagnostics signal, not an audit trail — one write per minute is plenty. */
const LAST_USED_UPDATE_THROTTLE_MS = 60_000;
const lastUsedWriteGates = new Set<string>();
/** authenticate() runs on EVERY x-api-key request — a short-lived cache keeps the
 * hot path at zero queries while key CRUD clears it (keys are few, clear is free). */
const authenticateCache = new MemoryCache<AuthenticatedApiKey>({ ttlMs: 5_000, maxSize: 200, name: "api-keys.auth" });

export type ApiKeyScope = "read_only" | "full";

export interface UpdateApiKeyInput {
	name?: string | undefined;
	expiresAtDays?: number | null | undefined;
}

export interface AuthenticatedApiKey {
	id: string;
	scope: ApiKeyScope;
	expiresAt: Date | null;
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

class ApiKeysService {
	readonly serviceName = "ApiKeysService";
	readonly logger = createLogger("ApiKeysService");

	async list(): Promise<ApiKey[]> {
		const rows = await apiKeysRepository.findAllWithCreator();

		return rows.map((row) => this.serialize(row.key, row.createdByName));
	}

	/** Renames a key or changes its expiry (`expiresAtDays` null removes it). The secret does not change. */
	async update(id: string, input: UpdateApiKeyInput, context?: AdminAuditContext): Promise<ApiKey> {
		const before = await this.requireRow(id);
		const changes: ApiKeyChanges = { updatedAt: new Date() };

		if (input.name !== undefined) {
			const name = input.name.trim();
			if (!name) throw new DomainError("validation", "API key name is required", { code: "api_key.name_required" });

			changes.name = name;
		}

		if (input.expiresAtDays !== undefined) {
			if (input.expiresAtDays !== null && (input.expiresAtDays < 1 || input.expiresAtDays > 3650)) {
				throw new DomainError("validation", "Expiry must be between 1 and 3650 days", { code: "api_key.expiry_invalid" });
			}

			changes.expiresAt = input.expiresAtDays === null ? null : new Date(Date.now() + input.expiresAtDays * 86_400_000);
		}

		await apiKeysRepository.update(id, changes);
		authenticateCache.clear();

		const after = await this.requireRow(id);
		recordAuditSafe(
			{
				action: "update",
				resourceType: "api_key",
				resourceId: id,
				before: { name: before.name, expiresAt: before.expiresAt?.toISOString() ?? null },
				after: { name: after.name, expiresAt: after.expiresAt?.toISOString() ?? null },
				context,
			},
			this.logger,
		);

		return this.serialize(after, await this.creatorName(after.createdBy));
	}

	/**
	 * Replaces a key's secret. One UPDATE swaps the stored hash, so the old secret stops matching in the
	 * same statement that stores the new one. The new secret is returned once; its last-used time resets.
	 */
	async rotate(id: string, context?: AdminAuditContext): Promise<ApiKeyCreated> {
		const row = await this.requireRow(id);
		const rawKey = this.newRawKey();
		const keyPrefix = rawKey.slice(0, 12);

		await apiKeysRepository.replaceSecret(id, hashKey(rawKey), keyPrefix, new Date());
		authenticateCache.clear();

		this.logger.info("API key rotated", { keyId: id });
		recordAuditSafe(
			{ action: "update", resourceType: "api_key", resourceId: id, summary: "rotated", after: { keyPrefix }, context },
			this.logger,
		);

		return {
			id,
			name: row.name,
			keyPrefix,
			scope: toScope(row.scope),
			expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
			lastUsedAt: null,
			createdAt: row.createdAt.toISOString(),
			key: rawKey,
		};
	}

	private async requireRow(id: string): Promise<ApiKeyRow> {
		const row = await apiKeysRepository.findById(id);
		if (!row) throw new DomainError("not_found", "API key not found", { code: "api_key.not_found" });

		return row;
	}

	private async creatorName(userId: string): Promise<string | null> {
		return await apiKeysRepository.findCreatorName(userId);
	}

	private newRawKey(): string {
		return `${KEY_TAG}${randomBytes(KEY_RANDOM_BYTES).toString("base64url")}`;
	}

	async create(
		input: { name: string; scope: ApiKeyScope; expiresAtDays?: number | undefined; creatorUserId: string },
		context?: AdminAuditContext,
	): Promise<ApiKeyCreated> {
		const name = input.name.trim();
		if (!name) throw new DomainError("validation", "API key name is required", { code: "api_key.name_required" });
		if (input.expiresAtDays !== undefined && (input.expiresAtDays < 1 || input.expiresAtDays > 3650)) {
			throw new DomainError("validation", "Expiry must be between 1 and 3650 days", { code: "api_key.expiry_invalid" });
		}

		const rawKey = this.newRawKey();
		const keyPrefix = rawKey.slice(0, 12);
		const now = new Date();
		const expiresAt = input.expiresAtDays === undefined ? null : new Date(now.getTime() + input.expiresAtDays * 86_400_000);
		const id = randomBytes(12).toString("base64url");

		await apiKeysRepository.insert({
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
		const removed = await apiKeysRepository.remove(id);
		if (removed === 0) throw new DomainError("not_found", "API key not found", { code: "api_key.not_found" });

		authenticateCache.clear();
		this.logger.info("API key revoked", { keyId: id });
		recordAuditSafe({ action: "delete", resourceType: "api_key", resourceId: id, context }, this.logger);
	}

	/** Resolves the owner of a presented key, or undefined when unknown or expired. */
	async authenticate(rawKey: string): Promise<AuthenticatedApiKey | undefined> {
		// One hash serves both the cache key and the stored-hash lookup.
		const keyHash = hashKey(rawKey);
		const now = new Date();
		const cached = authenticateCache.get(keyHash);
		// The cache outlives a key's expiry by up to its TTL, so a cached principal counts only until that moment.
		if (cached && (isNullish(cached.expiresAt) || cached.expiresAt > now)) return cached;

		const row = await apiKeysRepository.findActiveOwnerByHash(keyHash, now);
		if (!row) return undefined;

		this.touchLastUsed(row.id);

		const authenticated: AuthenticatedApiKey = {
			id: row.id,
			scope: toScope(row.scope),
			expiresAt: row.expiresAt,
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
					await apiKeysRepository.touchLastUsed(keyId, new Date());
				} catch (error) {
					this.logger.warn("Failed to refresh API key last-used timestamp", { keyId, error });
				} finally {
					// unref: a pending throttle gate must never keep the process alive during shutdown.
					setTimeout(() => lastUsedWriteGates.delete(keyId), LAST_USED_UPDATE_THROTTLE_MS).unref();
				}
			})(),
		);
	}

	private serialize(row: ApiKeyRow, createdByName: string | null): ApiKey {
		return {
			id: row.id,
			name: row.name,
			keyPrefix: row.keyPrefix,
			scope: toScope(row.scope),
			expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
			lastUsedAt: row.lastUsedAt ? row.lastUsedAt.toISOString() : null,
			createdAt: row.createdAt.toISOString(),
			createdByName,
		};
	}
}

export const apiKeysService = new ApiKeysService();
