import { timingSafeEqual } from "node:crypto";
import type { SetupStatus } from "@reelvault/sdk/common";
import { systemSettingsStore } from "@/config/system-settings.store";
import { usersRepository } from "@/database/repositories/users.repository";
import { env, generatedSecrets } from "@/env";
import { betterAuthApi } from "@/integrations/better-auth/better-auth.api";
import { BaseService } from "@/utils/base-service";
import { ConflictError, ForbiddenError, InternalError } from "@/utils/errors";

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

class FirstRunSetupService extends BaseService {
	private operation: Promise<void> = Promise.resolve();
	private firstRunHintLogged = false;

	constructor() {
		super("FirstRunSetupService");
	}

	private get tokenRequired(): boolean {
		return env.SETUP_TOKEN_ENABLED === "true";
	}

	async getStatus(): Promise<SetupStatus> {
		const required = await this.isRequired();
		if (required) this.logFirstRunHint();

		return { required, tokenRequired: this.tokenRequired };
	}

	async isRequired(): Promise<boolean> {
		return (await usersRepository.count()) === 0;
	}

	async registerUser(input: CreateUserInput): Promise<Response> {
		return await this.withExclusiveOperation(async () => {
			if (await this.isRequired()) {
				this.logFirstRunHint();
				throw new ForbiddenError("Complete first-run setup before registering users", { code: "auth.setup_incomplete" });
			}

			// Admin-toggleable: settings → System → allowRegistration.
			if (!systemSettingsStore.get("auth.allowRegistration")) {
				throw new ForbiddenError("User registration is disabled on this server", { code: "auth.registration_disabled" });
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
				throw new ForbiddenError("Invalid first-run setup token", { code: "auth.setup_token_invalid" });
			}
		}

		return await this.withExclusiveOperation(async () => {
			if (!(await this.isRequired()))
				throw new ConflictError("First-run setup has already been completed", { code: "auth.setup_completed" });

			const response = await betterAuthApi.signUpEmail({
				name: input.name,
				email: input.email,
				password: input.password,
			});

			if (!response.ok) return response;

			const user = await usersRepository.findByEmail(input.email);
			if (!user) throw new InternalError("First-run administrator was created without a user record");

			await usersRepository.promoteToAdmin(user.id);

			return response;
		});
	}

	async createAdminFromRequest(body: { name: string; email: string; password: string }, headers: Headers): Promise<Response> {
		return await this.safeExecute("createAdmin", () =>
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
