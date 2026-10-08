import { credentialsRepository } from "@/database/repositories/credentials.repository";
import { sessionsRepository } from "@/database/repositories/sessions.repository";
import { usersRepository } from "@/database/repositories/users.repository";
import { betterAuthApi } from "@/integrations/better-auth/better-auth.api";
import { BaseService } from "@/utils/base-service";
import { NotFoundError, ValidationError } from "@/utils/errors";

const MIN_PASSWORD_LENGTH = 8;
const MAX_PASSWORD_LENGTH = 128;

/**
 * Offline account recovery for self-hosted servers without a mail transport: the operator
 * resets a password (and optionally two-factor) from the command line, with filesystem access
 * to the database as the proof of authority. Every existing session of the user is revoked.
 */
class PasswordRecoveryService extends BaseService {
	constructor() {
		super("PasswordRecoveryService");
	}

	async resetPassword(input: {
		email: string;
		newPassword: string;
		disableTwoFactor?: boolean;
	}): Promise<{ userId: string; email: string }> {
		return await this.safeExecute("resetPassword", async () => {
			if (input.newPassword.length < MIN_PASSWORD_LENGTH || input.newPassword.length > MAX_PASSWORD_LENGTH) {
				throw new ValidationError(`Password must be ${MIN_PASSWORD_LENGTH}-${MAX_PASSWORD_LENGTH} characters`, {
					code: "auth.weak_password",
				});
			}

			const user = await usersRepository.findByEmail(input.email.trim());
			this.assertExists(user, "User", input.email);

			const updated = await credentialsRepository.setPasswordHash(user.id, await betterAuthApi.hashPassword(input.newPassword));
			if (!updated) {
				throw new NotFoundError(`User ${user.email} has no email/password login`, { code: "auth.no_password_login" });
			}

			if (input.disableTwoFactor) await credentialsRepository.clearTwoFactor(user.id);

			// A leaked session token must not survive the reset.
			await sessionsRepository.deleteAllForUser(user.id);

			return { userId: user.id, email: user.email };
		});
	}
}

export const passwordRecoveryService = new PasswordRecoveryService();
