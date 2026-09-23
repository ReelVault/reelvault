import { describe, expect, test } from "bun:test";
import type { Profile, User } from "@reelvault/sdk/common";
import { usersRepository } from "@/database/repositories/users.repository";
import { QuickConnectService } from "./quick-connect.service";

const CODE_REGEX = /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/;

describe("quickConnectService", () => {
	const mockUser: User = {
		id: "qc-user-123",
		name: "QC Test User",
		email: "qc@example.com",
		emailVerified: true,
		image: null,
		role: "user",
		twoFactorEnabled: false,
		banned: false,
		banReason: null,
		banExpires: null,
		createdAt: new Date(),
		updatedAt: new Date(),
	};

	const mockProfile: Profile = {
		id: "qc-profile-456",
		userId: "qc-user-123",
		name: "Main Profile",
		avatarUrl: null,
		pin: null,
		createdAt: new Date(),
		updatedAt: new Date(),
	};

	const mockIssueSession = (_userId: string, profileId?: string | null) => {
		const cookies = ["better-auth.session_token=mock-token.sig; Path=/; HttpOnly"];
		if (profileId) {
			cookies.push(`current_profile_id=${profileId}; Path=/; SameSite=Lax`);
		}

		return Promise.resolve({
			signedToken: "mock-token.sig",
			cookies,
		});
	};

	test("TV device pairing flow: initiate, poll pending, authorize, poll authenticated", async () => {
		const origFindById = usersRepository.findById;
		usersRepository.findById = async (id: string) => (id === mockUser.id ? mockUser : undefined);
		const service = new QuickConnectService(mockIssueSession);

		try {
			// 1. Initiate pairing
			const init = await service.initiate();
			expect(init.code).toMatch(CODE_REGEX);
			expect(init.secret).toBeDefined();
			expect(init.expiresIn).toBe(900);

			// 2. Poll before authorization
			const pollReq = new Request("http://localhost/check", { headers: { "x-client-shell": "native" } });
			const pendingRes = await service.check(init.secret, pollReq);
			const pendingData = (await pendingRes.json()) as { authenticated: boolean };
			expect(pendingData).toEqual({ authenticated: false });

			// 3. Authorize with code
			const authResult = await service.authorize(init.code, mockUser, mockProfile);
			expect(authResult).toEqual({ success: true });

			// 4. Poll after authorization
			const authRes = await service.check(init.secret, pollReq);
			expect(authRes.status).toBe(200);
			const authData = (await authRes.json()) as { authenticated: boolean; token: string; user: { id: string } };
			expect(authData.authenticated).toBe(true);
			expect(authData.token).toBeDefined();
			expect(authData.user.id).toBe(mockUser.id);
			expect(authRes.headers.get("set-cookie")).toContain("better-auth.session_token=");
			expect(authRes.headers.get("set-cookie")).toContain("current_profile_id=qc-profile-456");

			// 5. Poll again should fail because entry was consumed
			await expect(service.check(init.secret, pollReq)).rejects.toThrow("Quick connect session expired or not found");
		} finally {
			usersRepository.findById = origFindById;
		}
	});

	test("omits the JSON token for browser polls (cookie session only)", async () => {
		const origFindById = usersRepository.findById;
		usersRepository.findById = async (id: string) => (id === mockUser.id ? mockUser : undefined);
		const service = new QuickConnectService(mockIssueSession);

		try {
			const init = await service.initiate();
			await service.authorize(init.code, mockUser, mockProfile);
			const browserReq = new Request("http://localhost/check");
			const authRes = await service.check(init.secret, browserReq);
			const authData = (await authRes.json()) as { authenticated: boolean; token?: string };
			expect(authData.authenticated).toBe(true);
			expect(authData.token).toBeUndefined();
			expect(authRes.headers.get("set-cookie")).toContain("better-auth.session_token=");
		} finally {
			usersRepository.findById = origFindById;
		}
	});

	test("Voucher flow: generate, redeem, and prevent double redemption", async () => {
		const origFindById = usersRepository.findById;
		usersRepository.findById = async (id: string) => (id === mockUser.id ? mockUser : undefined);
		const service = new QuickConnectService(mockIssueSession);

		try {
			// 1. Generate voucher code
			const gen = await service.generate(mockUser, mockProfile);
			expect(gen.code).toMatch(CODE_REGEX);
			expect(gen.expiresIn).toBe(900);

			// 2. Redeem voucher code
			const req = new Request("http://localhost/redeem");
			const redeemRes = await service.redeem(gen.code, req);
			expect(redeemRes.status).toBe(200);
			const redeemData = (await redeemRes.json()) as { token: string; user: { id: string } };
			expect(redeemData.token).toBeDefined();
			expect(redeemData.user.id).toBe(mockUser.id);
			expect(redeemRes.headers.get("set-cookie")).toContain("better-auth.session_token=");

			// 3. Second redemption should fail (one-time use)
			await expect(service.redeem(gen.code, req)).rejects.toThrow("Invalid or expired login code");
		} finally {
			usersRepository.findById = origFindById;
		}
	});

	test("Rejects invalid codes", async () => {
		const service = new QuickConnectService(mockIssueSession);
		const req = new Request("http://localhost/redeem");
		await expect(service.redeem("000-000", req)).rejects.toThrow("Invalid or expired login code");
		await expect(service.authorize("000-000", mockUser)).rejects.toThrow("Invalid or expired quick connect code");
	});
});
