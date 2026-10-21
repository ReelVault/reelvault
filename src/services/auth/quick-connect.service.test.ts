import { beforeEach, describe, expect, test } from "bun:test";
import type { Profile, User } from "@reelvault/sdk/common";
import { insertUsers } from "../../../tests/helpers/rows.fixture";
import { useTestDatabase } from "../../../tests/helpers/test-database.helper";
import { QuickConnectService } from "./quick-connect.service";

const CODE_REGEX = /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/;

const { client } = useTestDatabase();

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

// The service loads the caller's user by id when it answers a poll or redeems a voucher.
beforeEach(async () => {
	await insertUsers(client(), { id: mockUser.id, name: mockUser.name, email: mockUser.email, emailVerified: true });
});

describe("quickConnectService TV pairing", () => {
	test("TV device pairing flow: initiate, poll pending, authorize, poll authenticated", async () => {
		const service = new QuickConnectService(mockIssueSession);

		// 1. Initiate pairing
		const init = await service.initiate();
		expect(init.code).toMatch(CODE_REGEX);
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
		expect(authData.user.id).toBe(mockUser.id);
		expect(authRes.headers.get("set-cookie")).toContain("better-auth.session_token=");
		expect(authRes.headers.get("set-cookie")).toContain("current_profile_id=qc-profile-456");

		// 5. Poll again should fail because entry was consumed
		await expect(service.check(init.secret, pollReq)).rejects.toMatchObject({
			category: "not_found",
			code: "quick_connect.session_expired",
		});
	});

	test("returns the JSON token to native polls and omits it for browser polls", async () => {
		const service = new QuickConnectService(mockIssueSession);

		const nativePair = await service.initiate();
		await service.authorize(nativePair.code, mockUser, mockProfile);
		const nativeRes = await service.check(
			nativePair.secret,
			new Request("http://localhost/check", { headers: { "x-client-shell": "native" } }),
		);
		expect(((await nativeRes.json()) as { token?: string }).token).toBe("mock-token.sig");

		const browserPair = await service.initiate();
		await service.authorize(browserPair.code, mockUser, mockProfile);
		const browserRes = await service.check(browserPair.secret, new Request("http://localhost/check"));
		const browserData = (await browserRes.json()) as { authenticated: boolean; token?: string };
		expect(browserData.authenticated).toBe(true);
		expect(browserData.token).toBeUndefined();
		expect(browserRes.headers.get("set-cookie")).toContain("better-auth.session_token=");
	});
});

describe("quickConnectService vouchers and codes", () => {
	test("Voucher flow: generate, redeem, and prevent double redemption", async () => {
		const service = new QuickConnectService(mockIssueSession);

		// 1. Generate voucher code
		const gen = await service.generate(mockUser, mockProfile);
		expect(gen.code).toMatch(CODE_REGEX);
		expect(gen.expiresIn).toBe(900);

		// 2. Redeem voucher code
		const req = new Request("http://localhost/redeem");
		const redeemRes = await service.redeem(gen.code, req);
		expect(redeemRes.status).toBe(200);
		const redeemData = (await redeemRes.json()) as { token: string; user: { id: string } };
		expect(redeemData.user.id).toBe(mockUser.id);
		expect(redeemRes.headers.get("set-cookie")).toContain("better-auth.session_token=");

		// 3. Second redemption should fail (one-time use)
		await expect(service.redeem(gen.code, req)).rejects.toMatchObject({ category: "not_found", code: "quick_connect.voucher_invalid" });
	});

	test("Rejects invalid codes", async () => {
		const service = new QuickConnectService(mockIssueSession);
		const req = new Request("http://localhost/redeem");
		await expect(service.redeem("000-000", req)).rejects.toMatchObject({ category: "not_found", code: "quick_connect.voucher_invalid" });
		await expect(service.authorize("000-000", mockUser)).rejects.toMatchObject({
			category: "not_found",
			code: "quick_connect.code_invalid",
		});
	});
});

describe("quickConnectService pending entries and PIN", () => {
	test("bounds pending entries and evicts the oldest when the cap is hit", async () => {
		const service = new QuickConnectService(mockIssueSession);
		let firstSecret = "";
		let lastSecret = "";
		for (let index = 0; index < 1001; index++) {
			const init = await service.initiate();
			if (index === 0) firstSecret = init.secret;
			lastSecret = init.secret;
		}

		const pollReq = new Request("http://localhost/check");
		await expect(service.check(firstSecret, pollReq)).rejects.toMatchObject({ code: "quick_connect.session_expired" });
		const lastResponse = await service.check(lastSecret, pollReq);
		expect(await lastResponse.json()).toEqual({ authenticated: false });
	});

	test("forwards the stored profile PIN to the session issuer", async () => {
		const issued: Array<[string, string | null | undefined, string | null | undefined]> = [];
		const issuer = (userId: string, profileId?: string | null, profilePin?: string | null) => {
			issued.push([userId, profileId, profilePin]);

			return Promise.resolve({ signedToken: "token.sig", cookies: [] as string[] });
		};
		const pinProfile: Profile = { ...mockProfile, pin: "hashed-pin" };
		const service = new QuickConnectService(issuer);

		const pair = await service.initiate();
		await service.authorize(pair.code, mockUser, pinProfile);
		const voucher = await service.generate(mockUser, pinProfile);
		await service.redeem(voucher.code, new Request("http://localhost/redeem"));

		expect(issued).toEqual([
			[mockUser.id, pinProfile.id, "hashed-pin"],
			[mockUser.id, pinProfile.id, "hashed-pin"],
		]);
	});
});
