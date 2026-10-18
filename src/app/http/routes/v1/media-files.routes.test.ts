import { expect, test } from "bun:test";
import { Elysia } from "elysia";
import { domainErrorsMiddleware } from "@/app/http/middleware/domain-errors.middleware";
import { mediaFilesRoutes } from "./media-files.routes";

const app = new Elysia().use(domainErrorsMiddleware).use(mediaFilesRoutes);

test("media file markers reject an unauthenticated request", async () => {
	const response = await app.handle(new Request("http://localhost/media-files/media-1/markers"));

	expect(response.status).toBe(401);
});
