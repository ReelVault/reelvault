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
import { profilePreferencesRepository } from "@/database/repositories/profile-preferences.repository";
import { profilesRepository } from "@/database/repositories/profiles.repository";
import { sessionsRepository } from "@/database/repositories/sessions.repository";
import { usersRepository } from "@/database/repositories/users.repository";
import { QueryPagination } from "@/database/utils/pagination";
import { betterAuthApi } from "@/integrations/better-auth/better-auth.api";
import { realtimeService } from "@/modules/realtime";
import { hasEntry } from "@/utils/array.utils";
import { BaseService } from "@/utils/base-service";
import { hashProfilePin } from "@/utils/crypto.utils";
import { ConflictError, ForbiddenError } from "@/utils/errors";
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

class AdminUsersService extends BaseService {
	constructor() {
		super("AdminUsersService");
	}

	async getAll(query: { search?: string; page?: number; limit?: number }): Promise<AdminUsersPage> {
		return await this.safeExecute("getAll", async () => {
			const pagination = QueryPagination.resolvePageParams(query, { defaultLimit: 25 });
			const { total, data } = await usersRepository.findForAdministration({
				search: query.search?.trim(),
				limit: pagination.limit,
				offset: pagination.offset,
			});

			return {
				data: data.map((item) => toAdminUser(item)),
				pagination: QueryPagination.buildAdminPagination({ total, page: pagination.page, limit: pagination.limit }),
			};
		});
	}

	async getById(userId: string): Promise<AdminUser> {
		return await this.safeExecute("getById", async () => {
			const user = await usersRepository.findById(userId);
			this.assertExists(user, "User", userId);

			return toAdminUser(user);
		});
	}

	async getByIdWithProfiles(userId: string): Promise<{ user: AdminUser; profiles: AdminUserProfile[] }> {
		return await this.safeExecute("getByIdWithProfiles", async () => {
			const [user, profiles] = await Promise.all([usersRepository.findById(userId), profilesRepository.findByUserId(userId)]);
			this.assertExists(user, "User", userId);

			return { user: toAdminUser(user), profiles: profiles.map((item) => toAdminUserProfile(item)) };
		});
	}

	async create(body: AdminCreateUser, actorId?: string, headers?: Headers): Promise<AdminUser> {
		return await this.safeExecute("create", async () => {
			this.assertExists(headers, "Request headers", "admin user create");
			const existing = await usersRepository.findByEmail(body.email);
			if (existing) throw new ConflictError("User with this email already exists", { code: "admin.user_email_conflict" });

			const result = await betterAuthApi.createUser({
				name: body.name,
				email: body.email,
				password: body.password,
				role: body.role ?? "user",
				headers,
			});

			const user = await usersRepository.findById(result.user.id);
			this.assertExists(user, "User", result.user.id);
			recordAuditSafe(
				{
					action: "create",
					resourceType: "user",
					resourceId: user.id,
					after: user,
					context: { actorUserId: actorId, headers },
				},
				this.logger,
			);

			return toAdminUser(user);
		});
	}

	async setPassword(userId: string, body: AdminSetUserPassword, actorId?: string, headers?: Headers): Promise<SuccessResponse> {
		return await this.safeExecute("setPassword", async () => {
			const user = await usersRepository.findById(userId);
			this.assertExists(user, "User", userId);
			this.assertExists(headers, "Request headers", "admin set password");

			await betterAuthApi.setUserPassword({ userId, newPassword: body.newPassword, headers });
			// A stolen session token must not survive a password reset.
			await sessionsRepository.deleteAllForUser(userId);
			realtimeService.disconnectUser(userId);
			recordAuditSafe(
				{
					action: "update",
					resourceType: "user",
					resourceId: userId,
					context: { actorUserId: actorId, headers },
				},
				this.logger,
			);

			return { success: true };
		});
	}

	async update(userId: string, body: AdminUserUpdate, actorId?: string, headers?: Headers): Promise<AdminUser> {
		return await this.safeExecute("update", async () => {
			const user = await usersRepository.findById(userId);
			this.assertExists(user, "User", userId);
			if (user.id === actorId && (body.role === "user" || body.banned)) {
				throw new ForbiddenError("You cannot remove your own administrative access", { code: "admin.self_demotion_forbidden" });
			}

			if (user.role === "admin" && body.role === "user") {
				await this.assertNotLastAdmin(user);
			}

			this.assertExists(headers, "Request headers", "admin user update");
			if (body.role !== undefined && body.role !== user.role) {
				await betterAuthApi.setRole({ userId, role: body.role, headers });
			}

			if (body.banned === true && !user.banned) {
				await betterAuthApi.banUser({ userId, banReason: body.banReason ?? undefined, headers });
				realtimeService.disconnectUser(userId);
			}

			if (body.banned === false && user.banned) {
				await betterAuthApi.unbanUser({ userId, headers });
			}

			const updated = await usersRepository.findById(userId);
			this.assertExists(updated, "User", userId);
			recordAuditSafe(
				{
					action: "update",
					resourceType: "user",
					resourceId: userId,
					before: user,
					after: updated,
					context: { actorUserId: actorId, headers },
				},
				this.logger,
			);

			return toAdminUser(updated);
		});
	}

	async delete(userId: string, actorId?: string, headers?: Headers): Promise<SuccessResponse> {
		return await this.safeExecute("delete", async () => {
			const user = await usersRepository.findById(userId);
			this.assertExists(user, "User", userId);
			if (user.id === actorId) throw new ForbiddenError("You cannot delete your own account", { code: "admin.self_delete_forbidden" });

			await this.assertNotLastAdmin(user);

			this.assertExists(headers, "Request headers", "admin user delete");
			await betterAuthApi.removeUser({ userId, headers });
			recordAuditSafe(
				{
					action: "delete",
					resourceType: "user",
					resourceId: userId,
					before: user,
					context: { actorUserId: actorId, headers },
				},
				this.logger,
			);

			return { success: true };
		});
	}

	async getProfiles(userId: string): Promise<AdminUserProfile[]> {
		return await this.safeExecute("getProfiles", async () => {
			const userExists = await usersRepository.isExists({ primaryId: userId });
			this.assertExists(userExists, "User", userId);

			const profiles = await profilesRepository.findByUserId(userId);

			return profiles.map((item) => toAdminUserProfile(item));
		});
	}

	async createProfile(userId: string, body: AdminCreateUserProfile, actorId?: string, headers?: Headers): Promise<AdminUserProfile> {
		return await this.safeExecute("createProfile", async () => {
			const [userExists, isNameTaken] = await Promise.all([
				usersRepository.isExists({ primaryId: userId }),
				profilesRepository.isNameTaken({ userId, name: body.name }),
			]);
			this.assertExists(userExists, "User", userId);
			if (isNameTaken) throw new ConflictError("Profile with the same name already exists", { code: "profile.name_conflict" });

			const profile = await profilesRepository.createAndRead(userId, {
				name: body.name,
				...(body.pin ? { pin: await hashProfilePin(body.pin) } : {}),
				...(body.avatarUrl ? { avatarUrl: body.avatarUrl } : {}),
			});
			this.assertExists(profile, "Profile", body.name);
			recordAuditSafe(
				{
					action: "create",
					resourceType: "profile",
					resourceId: profile.id,
					after: profile,
					context: { actorUserId: actorId, headers },
				},
				this.logger,
			);

			return toAdminUserProfile(profile);
		});
	}

	async getProfilePreferences(userId: string, profileId: string): Promise<ProfilePreferences> {
		return await this.safeExecute("getProfilePreferences", async () => {
			const profile = await this.getOwnedProfile(userId, profileId);

			return await profilePreferencesRepository.getEffective({ profileId: profile.id });
		});
	}

	async updateProfilePreferences(
		userId: string,
		profileId: string,
		body: UpdateProfilePreferences,
		actorId?: string,
		headers?: Headers,
	): Promise<ProfilePreferences> {
		return await this.safeExecute("updateProfilePreferences", async () => {
			const profile = await this.getOwnedProfile(userId, profileId);
			const preferences = await profilePreferencesRepository.applyUpdate({ profileId: profile.id, body });
			recordAuditSafe(
				{
					action: "update",
					resourceType: "profile",
					resourceId: profile.id,
					after: preferences,
					context: { actorUserId: actorId, headers },
				},
				this.logger,
			);

			return preferences;
		});
	}

	async resetProfilePreferences(userId: string, profileId: string, actorId?: string, headers?: Headers): Promise<ProfilePreferences> {
		return await this.safeExecute("resetProfilePreferences", async () => {
			const profile = await this.getOwnedProfile(userId, profileId);
			const preferences = await profilePreferencesRepository.reset({ profileId: profile.id });
			recordAuditSafe(
				{
					action: "delete",
					resourceType: "profile",
					resourceId: profile.id,
					after: preferences,
					context: { actorUserId: actorId, headers },
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
		actorId?: string,
		headers?: Headers,
	): Promise<AdminUserProfile> {
		return await this.safeExecute("updateProfile", async () => {
			const profile = await this.getOwnedProfile(userId, profileId);
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
					context: { actorUserId: actorId, headers },
				},
				this.logger,
			);

			return toAdminUserProfile(updated);
		});
	}

	async deleteProfile(userId: string, profileId: string, actorId?: string, headers?: Headers): Promise<SuccessResponse> {
		return await this.safeExecute("deleteProfile", async () => {
			const profile = await this.getOwnedProfile(userId, profileId);
			await profilesRepository.delete({ primaryId: profile.id });
			profilesRepository.invalidateCached(profile.id);
			recordAuditSafe(
				{
					action: "delete",
					resourceType: "profile",
					resourceId: profileId,
					before: profile,
					context: { actorUserId: actorId, headers },
				},
				this.logger,
			);

			return { success: true };
		});
	}

	private async getOwnedProfile(userId: string, profileId: string) {
		const profile = await profilesRepository.findByUserAndId(userId, profileId);
		this.assertExists(profile, "Profile", profileId);

		return profile;
	}

	/** Demoting or deleting the only remaining admin would lock the server out. */
	private async assertNotLastAdmin(user: { role: string }): Promise<void> {
		if (user.role !== "admin") return;

		const admins = await usersRepository.countAdministrators();
		if (admins <= 1) throw new ConflictError("At least one administrator must remain", { code: "admin.last_admin_protected" });
	}
}

function toAdminUser(user: NonNullable<Awaited<ReturnType<typeof usersRepository.selectFirst>>>): AdminUser {
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
