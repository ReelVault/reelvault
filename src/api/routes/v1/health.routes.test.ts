import { afterEach, expect, test } from "bun:test";
import { Elysia } from "elysia";
import { domainErrorsMiddleware } from "@/api/middleware/domain-errors.middleware";
import { mediaRepository } from "@/repositories/media-files.repository";
import { stubMethod } from "../../../../tests/helpers/method-stub.helper";
import { useTestDatabase } from "../../../../tests/helpers/test-database.helper";
import { healthRoutes } from "./health.routes";

// Readiness reads the migrated test database. Only the failure case stubs the probe, to
// simulate an outage the test database cannot produce on its own.
useTestDatabase();

const stubs: Array<{ restore(): void }> = [];
afterEach(() => {
	for (const stub of stubs.splice(0)) stub.restore();
});

const app = new Elysia().use(domainErrorsMiddleware).use(healthRoutes);

test("live answers while the database is down, because it probes nothing", async () => {
	stubs.push(stubMethod(mediaRepository, "ping", () => Promise.reject(new Error("db down"))));

	const res = await app.handle(new Request("http://localhost/health/live"));

	expect(res.status).toBe(200);
	expect(((await res.json()) as { status: string }).status).toBe("ok");
});

test("ready is 200 while the database answers", async () => {
	const res = await app.handle(new Request("http://localhost/health/ready"));
	const body = (await res.json()) as { status: string; subsystems: Array<{ name: string; status: string }> };

	expect(res.status).toBe(200);
	expect(body.status).toBe("ok");
	expect(body.subsystems).toEqual([{ name: "database", status: "healthy" }]);
});

test("ready is 503 when the database does not answer", async () => {
	stubs.push(stubMethod(mediaRepository, "ping", () => Promise.reject(new Error("db down"))));

	const res = await app.handle(new Request("http://localhost/health/ready"));
	const body = (await res.json()) as { status: string; subsystems: Array<{ status: string }> };

	expect(res.status).toBe(503);
	expect(body.status).toBe("degraded");
	expect(body.subsystems[0]?.status).toBe("unavailable");
});
