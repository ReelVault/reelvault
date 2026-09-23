import type {
	CreateProfile,
	FieldsQuery,
	PaginatedResponse,
	PaginationQuery,
	Profile,
	ProfileFilters,
	ProfilePreferenceDefaults,
	ProfilePreferences,
	ProfileSorting,
	SelectFields,
	SwitchProfile,
	UpdateProfile,
	UpdateProfilePreferences,
} from "@reelvault/sdk/common";
import { profilePreferencesRepository } from "@/database/repositories/profile-preferences.repository";
import { profilesRepository } from "@/database/repositories/profiles.repository";
import { QueryFields } from "@/database/utils/fields";
import { QueryUtils } from "@/database/utils/query-parser";
import { env } from "@/env";
import { imageProcessingService } from "@/modules/images/image-processing.service";

import { imageUploadService } from "@/modules/images/image-upload.service";
import { serverConfig } from "@/server.config";
import { BaseService } from "@/utils/base-service";
import { hashProfilePin, verifyProfilePin } from "@/utils/crypto.utils";
import { ConflictError, ForbiddenError } from "@/utils/errors";
import { profilePinFingerprint, signProfileUnlock } from "@/utils/profile-unlock.utils";

const EXTERNAL_AVATAR_URL_PATTERN = /^https?:\/\//i;

class ProfilesService extends BaseService {
	constructor() {
		super("ProfilesService");
	}

	#stripPin<T extends { pin: string | null }>(profile: T): T {
		// The (hashed) PIN never leaves the server; the frontend learns
		// "PIN required" from the switch endpoint's 403 instead.
		return { ...profile, pin: null };
	}

	async getAll<F extends string>(
		query?: PaginationQuery & FieldsQuery<F> & ProfileFilters & ProfileSorting,
		userId?: string,
	): Promise<PaginatedResponse<SelectFields<Profile, F>>> {
		return await this.safeExecute("getAll", async () => {
			this.assertUserId(userId);
			const page = await profilesRepository.findPage({ ...query, userId });

			return { ...page, data: page.data.map((row) => this.#stripPin(row)) };
		});
	}

	async getById<F extends string>(profileId: string, query?: FieldsQuery<F>, userId?: string): Promise<SelectFields<Profile, F>> {
		return await this.safeExecute("getById", async () => {
			this.assertUserId(userId);
			const profile = await profilesRepository.findByPrimaryId({ primaryId: profileId });
			this.assertExists(profile, "Profile", profileId);
			if (profile.userId !== userId)
				throw new ForbiddenError("Profile does not belong to the authenticated user", { code: "profile.not_owned" });

			const { fields } = QueryUtils.parseStandard(query);

			return QueryFields.apply(this.#stripPin(profile), fields);
		});
	}

	/**
	 * Profile avatars from external URLs (dicebear picker) violate the web-UI
	 * CSP `img-src 'self'` under single-port hosting and break offline instances.
	 * Download through the images pipeline once, then point the profile at the
	 * local /v1/images copy. Failures keep the original URL (visible fallback).
	 */
	async #localizeExternalAvatar(profileId: string, avatarUrl: string | null | undefined): Promise<string | null | undefined> {
		if (!(avatarUrl && EXTERNAL_AVATAR_URL_PATTERN.test(avatarUrl))) return avatarUrl;

		try {
			const { avatarUrl: localUrl } = await imageProcessingService.replaceProfileAvatarFromUrl(profileId, avatarUrl);

			return localUrl;
		} catch (error) {
			this.logger.warn(`Avatar localization failed for profile ${profileId}: ${String(error)}`);

			return avatarUrl;
		}
	}

	async create<F extends string>(body: CreateProfile, query?: FieldsQuery<F>, userId?: string): Promise<SelectFields<Profile, F>> {
		return await this.safeExecute("create", async () => {
			this.assertUserId(userId);
			// Administrative quota (0 = unlimited) — keep self-hosted instances from
			// unbounded profile growth.
			const maxProfiles = serverConfig.profiles.maxProfilesPerUser;
			if (maxProfiles > 0) {
				const owned = await profilesRepository.countByUserId(userId);
				if (owned >= maxProfiles) {
					throw new ConflictError(`Profile limit reached (${maxProfiles} per user)`, { code: "profile.limit_reached" });
				}
			}

			const isExists = await profilesRepository.isNameTaken({ userId, name: body.name });
			if (isExists) throw new ConflictError("Profile with the same name already exists", { code: "profile.name_conflict" });

			const payload = { ...body, pin: await hashProfilePin(body.pin) };
			const profile = await profilesRepository.createAndRead(userId, payload, query);
			this.assertExists(profile, "Profile", "newly created");

			const localized = await this.#localizeExternalAvatar(profile.id, profile.avatarUrl);
			if (localized !== undefined && localized !== profile.avatarUrl) {
				await profilesRepository.updateAndRead(profile.id, { avatarUrl: localized });
			}

			return this.#stripPin({ ...profile, avatarUrl: localized ?? profile.avatarUrl });
		});
	}

	async update<F extends string>(
		profileId: string,
		body: UpdateProfile,
		query?: FieldsQuery<F>,
		userId?: string,
	): Promise<SelectFields<Profile, F>> {
		return await this.safeExecute("update", async () => {
			const profile = await profilesRepository.findByPrimaryId({ primaryId: profileId });
			await this.assertOwnedProfile(profileId, userId, profile);

			const payload = { ...body, pin: await hashProfilePin(body.pin) };
			const result = await profilesRepository.updateAndRead(profileId, payload, query);
			this.assertExists(result, "Profile", profileId);

			const localized = await this.#localizeExternalAvatar(profileId, result.avatarUrl);
			if (localized !== undefined && localized !== result.avatarUrl) {
				const refreshed = await profilesRepository.updateAndRead(profileId, { avatarUrl: localized }, query);

				return this.#stripPin(refreshed ?? result);
			}

			return this.#stripPin(result);
		});
	}

	async delete(profileId: string, userId?: string): Promise<{ success: boolean }> {
		return await this.safeExecute("delete", async () => {
			this.assertUserId(userId);

			const profile = await this.getById(profileId, { fields: "id" }, userId);
			this.assertExists(profile, "Profile", profileId);

			await profilesRepository.deleteOwned({ profileId, userId });

			return { success: true };
		});
	}

	async switch(body: SwitchProfile, userId?: string): Promise<{ success: boolean; profileId: string; unlockToken: string | null }> {
		return await this.safeExecute("switch", async () => {
			this.assertUserId(userId);
			const profile = await profilesRepository.findByPrimaryId({ primaryId: body.profileId });
			this.assertExists(profile, "Profile", body.profileId);
			if (profile.userId !== userId)
				throw new ForbiddenError("Profile does not belong to the authenticated user", { code: "profile.not_owned" });

			if (profile.pin) {
				// Granular code — the client translates by code instead of matching
				// the (developer-facing) message string. A missing PIN answers with the
				// same code so the client opens the PIN modal instead of a generic error.
				if (!(body.pin && (await verifyProfilePin(profile.pin, body.pin)))) {
					throw new ForbiddenError("Invalid PIN", { code: "profile.pin_invalid" });
				}
			}

			// Proof (signed, HttpOnly) that this client passed the profile PIN, bound to
			// the current PIN hash. Only meaningful for PIN-protected profiles — a token
			// issued for an unprotected profile must not unlock it after a PIN is added.
			const unlockToken = profile.pin ? signProfileUnlock(profile.id, env.BETTER_AUTH_SECRET, profilePinFingerprint(profile.pin)) : null;

			return { success: true, profileId: profile.id, unlockToken };
		});
	}

	async getPreferences(profileId: string, userId?: string): Promise<ProfilePreferences> {
		return await this.safeExecute("getPreferences", async () => {
			const profile = await profilesRepository.findByPrimaryId({ primaryId: profileId });
			await this.assertOwnedProfile(profileId, userId, profile);

			return await profilePreferencesRepository.getEffective({ profileId });
		});
	}

	async updatePreferences(profileId: string, body: UpdateProfilePreferences, userId?: string): Promise<ProfilePreferences> {
		return await this.safeExecute("updatePreferences", async () => {
			const profile = await profilesRepository.findByPrimaryId({ primaryId: profileId });
			await this.assertOwnedProfile(profileId, userId, profile);

			return await profilePreferencesRepository.applyUpdate({ profileId, body });
		});
	}

	/** Server defaults every profile falls back to when it has no stored overrides. */
	getPreferenceDefaults(): ProfilePreferenceDefaults {
		return serverConfig.profiles.defaultPreferences;
	}

	async resetPreferences(profileId: string, userId?: string): Promise<ProfilePreferences> {
		return await this.safeExecute("resetPreferences", async () => {
			const profile = await profilesRepository.findByPrimaryId({ primaryId: profileId });
			await this.assertOwnedProfile(profileId, userId, profile);

			return await profilePreferencesRepository.reset({ profileId });
		});
	}

	async uploadAvatar(profileId: string, file: File, userId?: string): Promise<{ avatarUrl: string }> {
		return await this.safeExecute("uploadAvatar", async () => {
			const profile = await profilesRepository.findByPrimaryId({ primaryId: profileId });
			await this.assertOwnedProfile(profileId, userId, profile);

			const uploaded = await imageUploadService.upload(file, { ownerType: "profile", ownerId: profileId, variant: "avatar" });
			const { avatarUrl } = await imageProcessingService.replaceProfileAvatarWithUpload(profileId, uploaded);

			return { avatarUrl };
		});
	}

	private async assertOwnedProfile(profileId: string, userId?: string, preFetchedProfile?: Profile): Promise<void> {
		this.assertUserId(userId);
		const profile = preFetchedProfile ?? (await profilesRepository.findByPrimaryId({ primaryId: profileId }));
		this.assertExists(profile, "Profile", profileId);
		if (profile.userId !== userId)
			throw new ForbiddenError("Profile does not belong to the authenticated user", { code: "profile.not_owned" });
	}
}

export const profilesService = new ProfilesService();
