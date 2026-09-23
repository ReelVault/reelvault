import { auth } from "./better-auth.config";
import { invalidateSessionCache } from "./better-auth.session-cache";

interface SignUpInput {
	name: string;
	email: string;
	password: string;
}

interface CreateUserInput {
	name: string;
	email: string;
	password: string;
	role: "admin" | "user";
	headers: Headers;
}

/**
 * Integration adapter for the better-auth server API. Application use cases call
 * this instead of `auth.api.*` directly, so better-auth stays in the
 * infrastructure layer.
 */
export const betterAuthApi = {
	async signUpEmail(input: SignUpInput): Promise<Response> {
		return await auth.api.signUpEmail({ body: input, asResponse: true });
	},

	async signInEmail(input: { email: string; password: string }): Promise<Response> {
		return await auth.api.signInEmail({ body: input, asResponse: true });
	},

	async signOut(headers: Headers): Promise<Response> {
		const response = await auth.api.signOut({ headers, asResponse: true });
		invalidateSessionCache();

		return response;
	},

	async revokeSession(input: { token: string; headers: Headers }): Promise<void> {
		await auth.api.revokeSession({ body: { token: input.token }, headers: input.headers });
		invalidateSessionCache();
	},

	async createUser(input: CreateUserInput): Promise<{ user: { id: string } }> {
		return await auth.api.createUser({
			body: { name: input.name, email: input.email, password: input.password, role: input.role },
			headers: input.headers,
		});
	},

	async setUserPassword(input: { userId: string; newPassword: string; headers: Headers }): Promise<void> {
		await auth.api.setUserPassword({ body: { userId: input.userId, newPassword: input.newPassword }, headers: input.headers });
		invalidateSessionCache();
	},

	async setRole(input: { userId: string; role: "admin" | "user"; headers: Headers }): Promise<void> {
		await auth.api.setRole({ body: { userId: input.userId, role: input.role }, headers: input.headers });
		invalidateSessionCache();
	},

	async banUser(input: { userId: string; banReason?: string | undefined; headers: Headers }): Promise<void> {
		await auth.api.banUser({ body: { userId: input.userId, banReason: input.banReason }, headers: input.headers });
		invalidateSessionCache();
	},

	async unbanUser(input: { userId: string; headers: Headers }): Promise<void> {
		await auth.api.unbanUser({ body: { userId: input.userId }, headers: input.headers });
		invalidateSessionCache();
	},

	async removeUser(input: { userId: string; headers: Headers }): Promise<void> {
		await auth.api.removeUser({ body: { userId: input.userId }, headers: input.headers });
		invalidateSessionCache();
	},

	async enableTwoFactor(input: { password: string; headers: Headers }): Promise<Response> {
		const response = await auth.api.enableTwoFactor({ body: { password: input.password }, headers: input.headers, asResponse: true });
		invalidateSessionCache();

		return response;
	},

	async disableTwoFactor(input: { password: string; headers: Headers }): Promise<Response> {
		const response = await auth.api.disableTwoFactor({ body: { password: input.password }, headers: input.headers, asResponse: true });
		invalidateSessionCache();

		return response;
	},

	async verifyTotp(input: { code: string; headers: Headers }): Promise<Response> {
		return await auth.api.verifyTOTP({ body: { code: input.code }, headers: input.headers, asResponse: true });
	},

	async verifyBackupCode(input: { code: string; headers: Headers }): Promise<Response> {
		return await auth.api.verifyBackupCode({ body: { code: input.code }, headers: input.headers, asResponse: true });
	},

	async generateBackupCodes(input: { password: string; headers: Headers }): Promise<Response> {
		return await auth.api.generateBackupCodes({ body: { password: input.password }, headers: input.headers, asResponse: true });
	},
};
