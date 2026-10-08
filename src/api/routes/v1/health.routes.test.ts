import { afterEach, expect, test } from "bun:test";
import { Elysia } from "elysia";
import { mediaRepository } from "@/database/repositories/media-files.repository";
import { domainErrorsMiddleware } from "@/middleware/domain-errors.middleware";
import { stubMethod } from "../../../../tests/helpers/method-stub";
import { healthRoutes } from "./health.routes";

const stubs: Array<{ restore(): void }> = [];
afterEach(() => {
	for (const stub of stubs.splice(0)) stub.restore();
});

const app = new Elysia().use(domainErrorsMiddleware).use(healthRoutes);

test("live answers without probing any dependency", async () => {
	const ping = stubMethod(mediaRepository, "ping", () => Promise.reject(new Error("db down")));
	stubs.push(ping);

	const res = await app.handle(new Request("http://localhost/health/live"));

	expect(res.status).toBe(200);
	expect(((await res.json()) as { status: string }).status).toBe("ok");
	expect(ping.calls).toHaveLength(0);
});

test("ready is 200 while the database answers", async () => {
	stubs.push(stubMethod(mediaRepository, "ping", () => Promise.resolve()));

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
