import { betterAuthApi } from "@/integrations/better-auth/better-auth.api";
import { credentialsRepository } from "@/repositories/credentials.repository";
import { sessionsRepository } from "@/repositories/sessions.repository";
import { usersRepository } from "@/repositories/users.repository";
import { assertFound, DomainError } from "@/utils/domain.errors";
import { createLogger } from "@/utils/logger.utils";
import { runSafely } from "@/utils/safe-execute.utils";

const MIN_PASSWORD_LENGTH = 8;
const MAX_PASSWORD_LENGTH = 128;

/**
 * Offline account recovery for self-hosted servers without a mail transport: the operator
 * resets a password (and optionally two-factor) from the command line, with filesystem access
 * to the database as the proof of authority. Every existing session of the user is revoked.
 */
export const passwordRecoveryService = {
	serviceName: "PasswordRecoveryService",
	logger: createLogger("PasswordRecoveryService"),

	async resetPassword(input: {
		email: string;
		newPassword: string;
		disableTwoFactor?: boolean;
	}): Promise<{ userId: string; email: string }> {
		return await runSafely(passwordRecoveryService, "resetPassword", async () => {
			if (input.newPassword.length < MIN_PASSWORD_LENGTH || input.newPassword.length > MAX_PASSWORD_LENGTH) {
				throw new DomainError("validation", `Password must be ${MIN_PASSWORD_LENGTH}-${MAX_PASSWORD_LENGTH} characters`, {
					code: "auth.weak_password",
				});
			}

			const user = await usersRepository.findByEmail(input.email.trim());
			assertFound(user, "User", input.email);

			const updated = await credentialsRepository.setPasswordHash(user.id, await betterAuthApi.hashPassword(input.newPassword));
			if (!updated) {
				throw new DomainError("not_found", `User ${user.email} has no email/password login`, { code: "auth.no_password_login" });
			}

			if (input.disableTwoFactor) await credentialsRepository.clearTwoFactor(user.id);

			// A leaked session token must not survive the reset.
			await sessionsRepository.deleteAllForUser(user.id);

			return { userId: user.id, email: user.email };
		});
	},
};
