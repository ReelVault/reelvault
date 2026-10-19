import { timingSafeEqual } from "node:crypto";
import type { SetupStatus } from "@reelvault/sdk/common";
import { usersRepository } from "@/app/repositories/users.repository";
import { env, generatedSecrets } from "@/config/env.config";
import { systemSettingsStore } from "@/config/system-settings.store";
import { betterAuthApi } from "@/integrations/better-auth/better-auth.api";
import { toAuthFailure } from "@/integrations/better-auth/better-auth.failures";
import { DomainError } from "@/utils/domain.errors";
import { createLogger } from "@/utils/logger.utils";
import { runSafely } from "@/utils/safe-execute.utils";

interface CreateAdminInput {
	token: string | null;
	name: string;
	email: string;
	password: string;
}

interface CreateUserInput {
	name: string;
	email: string;
	password: string;
}

class FirstRunSetupService {
	readonly serviceName = "FirstRunSetupService";
	readonly logger = createLogger("FirstRunSetupService");

	private operation: Promise<void> = Promise.resolve();
	private firstRunHintLogged = false;

	private get tokenRequired(): boolean {
		return env.SETUP_TOKEN_ENABLED === "true";
	}

	async getStatus(): Promise<SetupStatus> {
		const required = await this.isRequired();
		if (required) this.logFirstRunHint();

		return { required, tokenRequired: this.tokenRequired };
	}

	async isRequired(): Promise<boolean> {
		// A yes/no answer, not a total: the count scanned the whole users table
		// for every status poll.
		return !(await usersRepository.hasAny());
	}

	async registerUser(input: CreateUserInput): Promise<Response> {
		return await this.withExclusiveOperation(async () => {
			if (await this.isRequired()) {
				this.logFirstRunHint();
				throw new DomainError("forbidden", "Complete first-run setup before registering users", { code: "auth.setup_incomplete" });
			}

			// Admin-toggleable: settings → System → allowRegistration.
			if (!systemSettingsStore.get("auth.allowRegistration")) {
				throw new DomainError("forbidden", "User registration is disabled on this server", { code: "auth.registration_disabled" });
			}

			return await betterAuthApi.signUpEmail(input);
		});
	}

	async createAdmin(input: CreateAdminInput): Promise<Response> {
		// Opt-in hardening for exposed instances (SETUP_TOKEN_ENABLED=true). A
		// default home install completes setup straight from the wizard.
		if (this.tokenRequired) {
			// Constant-time comparison — equalizes the response time for wrong tokens.
			const provided = Buffer.from(input.token ?? "");
			const expected = Buffer.from(env.SETUP_TOKEN ?? "");
			const tokensMatch = provided.length === expected.length && timingSafeEqual(provided, expected);
			if (!tokensMatch) {
				throw new DomainError("forbidden", "Invalid first-run setup token", { code: "auth.setup_token_invalid" });
			}
		}

		return await this.withExclusiveOperation(async () => {
			if (!(await this.isRequired()))
				throw new DomainError("conflict", "First-run setup has already been completed", { code: "auth.setup_completed" });

			const response = await betterAuthApi.signUpEmail({
				name: input.name,
				email: input.email,
				password: input.password,
			});

			if (!response.ok) throw await toAuthFailure(response);

			const user = await usersRepository.findByEmail(input.email);
			if (!user)
				throw new DomainError("internal", "First-run administrator was created without a user record", { code: "auth.setup_user_missing" });

			await usersRepository.promoteToAdmin(user.id);

			return response;
		});
	}

	async createAdminFromRequest(body: { name: string; email: string; password: string }, headers: Headers): Promise<Response> {
		return await runSafely(this, "createAdmin", () =>
			this.createAdmin({
				token: headers.get("x-setup-token"),
				name: body.name,
				email: body.email,
				password: body.password,
			}),
		);
	}

	private async withExclusiveOperation<T>(operation: () => Promise<T>): Promise<T> {
		const previous = this.operation;
		let release!: () => void;
		this.operation = new Promise<void>((resolve) => {
			release = resolve;
		});

		await previous;
		try {
			return await operation();
		} finally {
			release();
		}
	}

	private logFirstRunHint(): void {
		if (this.firstRunHintLogged) return;

		this.firstRunHintLogged = true;

		if (!this.tokenRequired) {
			this.logger.warn(
				"First-run setup required. Open ReelVault in your browser and create the administrator account in the setup wizard.",
			);

			return;
		}

		const token = env.SETUP_TOKEN;
		if (generatedSecrets.SETUP_TOKEN && token) {
			this.logger.warn(`First-run setup required. One-time setup token: ${token} — this message is shown once.`);

			return;
		}

		this.logger.warn("First-run setup required. Use the configured SETUP_TOKEN.");
	}
}

export const firstRunSetupService = new FirstRunSetupService();
