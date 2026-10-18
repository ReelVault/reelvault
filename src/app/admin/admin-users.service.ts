import type {
	AdminCreateUser,
	AdminCreateUserProfile,
	AdminSetUserPassword,
	AdminUser,
	AdminUserProfile,
	AdminUsersPage,
	ProfilePreferences,
	SuccessResponse,
	UpdateProfilePreferences,
} from "@reelvault/sdk/common";
import type { AdminAuditContext } from "@/app/repositories/admin-audit.repository";
import { profilePreferencesRepository } from "@/app/repositories/profile-preferences.repository";
import { profilesRepository } from "@/app/repositories/profiles.repository";
import { type SessionActivity, sessionsRepository } from "@/app/repositories/sessions.repository";
import { usersRepository } from "@/app/repositories/users.repository";
import { betterAuthApi } from "@/integrations/better-auth/better-auth.api";
import { QueryPagination } from "@/integrations/drizzle-orm/query/pagination.utils";
import { realtimeService } from "@/modules/realtime/realtime.service";
import { hasEntry } from "@/utils/array.utils";
import { hashProfilePin } from "@/utils/crypto.utils";
import { assertFound, assertPresent, DomainError } from "@/utils/domain.errors";
import { createLogger } from "@/utils/logger.utils";
import { runSafely } from "@/utils/safe-execute.utils";
import { recordAuditSafe } from "./admin-audit.service";

interface AdminUserUpdate {
	role?: "admin" | "user" | undefined;
	banned?: boolean | undefined;
	banReason?: string | null | undefined;
}

interface AdminUserProfileUpdate {
	name?: string;
	avatarUrl?: string | null | undefined;
	pin?: string | null | undefined;
}

class AdminUsersService {
	readonly serviceName = "AdminUsersService";
	readonly logger = createLogger("AdminUsersService");

	async getAll(query: {
		q?: string;
		role?: "admin" | "user" | undefined;
		status?: "active" | "blocked" | undefined;
		page?: number;
		limit?: number;
	}): Promise<AdminUsersPage> {
		return await runSafely(this, "getAll", async () => {
			const pagination = QueryPagination.resolvePageParams(query, { defaultLimit: 25 });
			const { total, data } = await usersRepository.findForAdministration({
				search: query.q?.trim(),
				role: query.role,
				banned: query.status === undefined ? undefined : query.status === "blocked",
				limit: pagination.limit,
				offset: pagination.offset,
			});

			return {
				...QueryPagination.buildAdminPagination({ total, page: pagination.page, limit: pagination.limit }),
				data: await this.toAdminUsers(data),
			};
		});
	}

	/** Per-user session activity for a page of users, in one query. */
	private async toAdminUsers(users: AdminUserRow[]): Promise<AdminUser[]> {
		const activity = await sessionsRepository.findActivitySummaryByUserIds(users.map((user) => user.id));

		return users.map((user) => toAdminUser(user, activity.get(user.id)));
	}

	private async activityOf(userId: string): Promise<SessionActivity | undefined> {
		return (await sessionsRepository.findActivitySummaryByUserIds([userId])).get(userId);
	}

	/** The user's sessions that have not expired, newest first. Tokens are never returned. */
	async getSessions(userId: string, query: { page?: number; limit?: number }) {
		return await runSafely(this, "getSessions", async () => {
			const user = await usersRepository.findById(userId);
			assertFound(user, "User", userId);

			const page = await sessionsRepository.findActivePageByUserId(userId, query);

			return {
				...page,
				data: page.data.map((session) => ({
					id: session.id,
					ipAddress: session.ipAddress,
					userAgent: session.userAgent,
					createdAt: session.createdAt.toISOString(),
					updatedAt: session.updatedAt.toISOString(),
					expiresAt: session.expiresAt.toISOString(),
				})),
			};
		});
	}

	/** Ends one session of a user. */
	async revokeSession(userId: string, sessionId: string, context?: AdminAuditContext) {
		return await runSafely(this, "revokeSession", async () => {
			const revoked = await sessionsRepository.deleteForUser({ userId, sessionId });
			assertFound(revoked || undefined, "Session", sessionId);

			recordAuditSafe({ action: "delete", resourceType: "user_session", resourceId: sessionId, after: { userId }, context }, this.logger);

			return { success: true };
		});
	}

	/** Ends every session of the listed users at once. */
	async revokeSessionsForUsers(userIds: string[], context?: AdminAuditContext) {
		return await runSafely(this, "revokeSessionsForUsers", async () => {
			const revokedSessions = await sessionsRepository.deleteForUsers(userIds);

			recordAuditSafe(
				{ action: "delete", resourceType: "user_session", resourceId: "bulk", after: { userIds, revokedSessions }, context },
				this.logger,
			);

			return { revokedSessions };
		});
	}

	async getById(userId: string): Promise<AdminUser> {
		return await runSafely(this, "getById", async () => {
			const user = await usersRepository.findById(userId);
			assertFound(user, "User", userId);

			return toAdminUser(user, await this.activityOf(userId));
		});
	}

	async getByIdWithProfiles(userId: string): Promise<{ user: AdminUser; profiles: AdminUserProfile[] }> {
		return await runSafely(this, "getByIdWithProfiles", async () => {
			const [user, profiles] = await Promise.all([usersRepository.findById(userId), profilesRepository.findByUserId(userId)]);
			assertFound(user, "User", userId);

			return { user: toAdminUser(user), profiles: profiles.map((item) => toAdminUserProfile(item)) };
		});
	}

	async create(body: AdminCreateUser, context?: AdminAuditContext): Promise<AdminUser> {
		return await runSafely(this, "create", async () => {
			assertPresent(context?.headers, "Request headers are required to create an admin user");
			const existing = await usersRepository.findByEmail(body.email);
			if (existing) throw new DomainError("conflict", "User with this email already exists", { code: "admin.user_email_conflict" });

			const result = await betterAuthApi.createUser({
				name: body.name,
				email: body.email,
				password: body.password,
				role: body.role ?? "user",
				headers: context.headers,
			});

			const user = await usersRepository.findById(result.user.id);
			assertFound(user, "User", result.user.id);
			recordAuditSafe(
				{
					action: "create",
					resourceType: "user",
					resourceId: user.id,
					after: user,
					context,
				},
				this.logger,
			);

			return toAdminUser(user);
		});
	}

	async setPassword(userId: string, body: AdminSetUserPassword, context?: AdminAuditContext): Promise<SuccessResponse> {
		return await runSafely(this, "setPassword", async () => {
			const user = await usersRepository.findById(userId);
			assertFound(user, "User", userId);
			assertPresent(context?.headers, "Request headers are required to set a user password");

			await betterAuthApi.setUserPassword({ userId, newPassword: body.newPassword, headers: context.headers });
			// A stolen session token must not survive a password reset.
			await sessionsRepository.deleteAllForUser(userId);
			realtimeService.disconnectUser(userId);
			recordAuditSafe(
				{
					action: "update",
					resourceType: "user",
					resourceId: userId,
					context,
				},
				this.logger,
			);

			return { success: true };
		});
	}

	async update(userId: string, body: AdminUserUpdate, context?: AdminAuditContext): Promise<AdminUser> {
		return await runSafely(this, "update", async () => {
			const user = await usersRepository.findById(userId);
			assertFound(user, "User", userId);
			if (user.id === context?.actorUserId && (body.role === "user" || body.banned)) {
				throw new DomainError("forbidden", "You cannot remove your own administrative access", { code: "admin.self_demotion_forbidden" });
			}

			if (user.role === "admin" && body.role === "user") {
				await this.assertNotLastAdmin(user);
			}

			assertPresent(context?.headers, "Request headers are required to update an admin user");
			if (body.role !== undefined && body.role !== user.role) {
				await betterAuthApi.setRole({ userId, role: body.role, headers: context.headers });
			}

			if (body.banned === true && !user.banned) {
				await betterAuthApi.banUser({ userId, banReason: body.banReason ?? undefined, headers: context.headers });
				realtimeService.disconnectUser(userId);
			}

			if (body.banned === false && user.banned) {
				await betterAuthApi.unbanUser({ userId, headers: context.headers });
			}

			const updated = await usersRepository.findById(userId);
			assertFound(updated, "User", userId);
			recordAuditSafe(
				{
					action: "update",
					resourceType: "user",
					resourceId: userId,
					before: user,
					after: updated,
					context,
				},
				this.logger,
			);

			return toAdminUser(updated);
		});
	}

	async delete(userId: string, context?: AdminAuditContext): Promise<SuccessResponse> {
		return await runSafely(this, "delete", async () => {
			const user = await usersRepository.findById(userId);
			assertFound(user, "User", userId);
			if (user.id === context?.actorUserId)
				throw new DomainError("forbidden", "You cannot delete your own account", { code: "admin.self_delete_forbidden" });

			await this.assertNotLastAdmin(user);

			assertPresent(context?.headers, "Request headers are required to delete an admin user");
			await betterAuthApi.removeUser({ userId, headers: context.headers });
			recordAuditSafe(
				{
					action: "delete",
					resourceType: "user",
					resourceId: userId,
					before: user,
					context,
				},
				this.logger,
			);

			return { success: true };
		});
	}

	async getProfiles(userId: string): Promise<AdminUserProfile[]> {
		return await runSafely(this, "getProfiles", async () => {
			const userExists = await usersRepository.isExists({ primaryId: userId });
			assertFound(userExists, "User", userId);

			const profiles = await profilesRepository.findByUserId(userId);

			return profiles.map((item) => toAdminUserProfile(item));
		});
	}

	async createProfile(userId: string, body: AdminCreateUserProfile, context?: AdminAuditContext): Promise<AdminUserProfile> {
		return await runSafely(this, "createProfile", async () => {
			const [userExists, isNameTaken] = await Promise.all([
				usersRepository.isExists({ primaryId: userId }),
				profilesRepository.isNameTaken({ userId, name: body.name }),
			]);
			assertFound(userExists, "User", userId);
			if (isNameTaken) throw new DomainError("conflict", "Profile with the same name already exists", { code: "profile.name_conflict" });

			const profile = await profilesRepository.createAndRead(userId, {
				name: body.name,
				...(body.pin ? { pin: await hashProfilePin(body.pin) } : {}),
				...(body.avatarUrl ? { avatarUrl: body.avatarUrl } : {}),
			});
			assertFound(profile, "Profile", body.name);
			recordAuditSafe(
				{
					action: "create",
					resourceType: "profile",
					resourceId: profile.id,
					after: profile,
					context,
				},
				this.logger,
			);

			return toAdminUserProfile(profile);
		});
	}

	async getProfilePreferences(userId: string, profileId: string): Promise<ProfilePreferences> {
		return await runSafely(this, "getProfilePreferences", async () => {
			const profile = await this.getOwnedProfile(userId, profileId);

			return await profilePreferencesRepository.getEffective({ profileId: profile.id });
		});
	}

	async updateProfilePreferences(
		userId: string,
		profileId: string,
		body: UpdateProfilePreferences,
		context?: AdminAuditContext,
	): Promise<ProfilePreferences> {
		return await runSafely(this, "updateProfilePreferences", async () => {
			const profile = await this.getOwnedProfile(userId, profileId);
			const preferences = await profilePreferencesRepository.applyUpdate({ profileId: profile.id, body });
			recordAuditSafe(
				{
					action: "update",
					resourceType: "profile",
					resourceId: profile.id,
					after: preferences,
					context,
				},
				this.logger,
			);

			return preferences;
		});
	}

	async resetProfilePreferences(userId: string, profileId: string, context?: AdminAuditContext): Promise<ProfilePreferences> {
		return await runSafely(this, "resetProfilePreferences", async () => {
			const profile = await this.getOwnedProfile(userId, profileId);
			const preferences = await profilePreferencesRepository.reset({ profileId: profile.id });
			recordAuditSafe(
				{
					action: "delete",
					resourceType: "profile",
					resourceId: profile.id,
					after: preferences,
					context,
				},
				this.logger,
			);

			return preferences;
		});
	}

	async updateProfile(
		userId: string,
		profileId: string,
		body: AdminUserProfileUpdate,
		context?: AdminAuditContext,
	): Promise<AdminUserProfile> {
		return await runSafely(this, "updateProfile", async () => {
			const profile = await this.getOwnedProfile(userId, profileId);
			if (body.name !== undefined && body.name !== profile.name) {
				const nameTaken = await profilesRepository.isNameTaken({ userId, name: body.name, excludeId: profile.id });
				if (nameTaken) throw new DomainError("conflict", "Profile with the same name already exists", { code: "profile.name_conflict" });
			}

			const payload: AdminUserProfileUpdate = { ...body };
			if (body.pin !== undefined) {
				payload.pin = body.pin ? await hashProfilePin(body.pin) : null;
			}

			const updated = hasEntry(payload) ? ((await profilesRepository.updateAndRead(profile.id, payload)) ?? profile) : profile;
			recordAuditSafe(
				{
					action: "update",
					resourceType: "profile",
					resourceId: profileId,
					before: profile,
					after: updated,
					context,
				},
				this.logger,
			);

			return toAdminUserProfile(updated);
		});
	}

	async deleteProfile(userId: string, profileId: string, context?: AdminAuditContext): Promise<SuccessResponse> {
		return await runSafely(this, "deleteProfile", async () => {
			const profile = await this.getOwnedProfile(userId, profileId);
			await profilesRepository.delete({ primaryId: profile.id });
			profilesRepository.invalidateCached(profile.id);
			recordAuditSafe(
				{
					action: "delete",
					resourceType: "profile",
					resourceId: profileId,
					before: profile,
					context,
				},
				this.logger,
			);

			return { success: true };
		});
	}

	private async getOwnedProfile(userId: string, profileId: string) {
		const profile = await profilesRepository.findByUserAndId(userId, profileId);
		assertFound(profile, "Profile", profileId);

		return profile;
	}

	/** Demoting or deleting the only remaining admin would lock the server out. */
	private async assertNotLastAdmin(user: { role: string }): Promise<void> {
		if (user.role !== "admin") return;

		const admins = await usersRepository.countAdministrators();
		if (admins <= 1) throw new DomainError("conflict", "At least one administrator must remain", { code: "admin.last_admin_protected" });
	}
}

type AdminUserRow = NonNullable<Awaited<ReturnType<typeof usersRepository.selectFirst>>>;

function toAdminUser(user: AdminUserRow, activity?: SessionActivity): AdminUser {
	return {
		id: user.id,
		name: user.name,
		email: user.email,
		role: user.role === "admin" ? "admin" : "user",
		banned: user.banned,
		banReason: user.banReason,
		banExpires: user.banExpires?.toISOString() ?? null,
		twoFactorEnabled: user.twoFactorEnabled,
		createdAt: user.createdAt.toISOString(),
		updatedAt: user.updatedAt.toISOString(),
		lastActiveAt: activity?.lastActiveAt?.toISOString() ?? null,
		activeSessionCount: activity?.activeSessionCount ?? 0,
	};
}

function toAdminUserProfile(profile: NonNullable<Awaited<ReturnType<typeof profilesRepository.selectFirst>>>): AdminUserProfile {
	return {
		id: profile.id,
		userId: profile.userId,
		name: profile.name,
		avatarUrl: profile.avatarUrl,
		hasPin: Boolean(profile.pin),
		createdAt: profile.createdAt.toISOString(),
		updatedAt: profile.updatedAt.toISOString(),
	};
}

export const adminUsersService = new AdminUsersService();
