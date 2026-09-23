import type { ImageQuery } from "@reelvault/sdk/common";
import { Elysia, t } from "elysia";
import { commonModel, ROUTE_ERRORS } from "@/api/schemas/common.schemas";
import { binaryFileResponse } from "@/api/utils/binary-response.utils";
import { authMiddleware } from "@/middleware/auth.middleware";
import { rateLimitMiddleware } from "@/middleware/rate-limit.middleware";
import { imagesService } from "@/modules/images/images.service";

const IMAGE_CACHE_CONTROL = "public, max-age=86400, immutable";

export const imagesRoutes = new Elysia({
	prefix: "/images",
	tags: ["Images"],
})
	.use(commonModel)
	.use(rateLimitMiddleware)
	// INTENTIONALLY PUBLIC (mounted before authMiddleware below): posters/backdrops
	// must render in <img> contexts that cannot attach auth headers (TV browsers,
	// QR flows, plugin UI assets). IDs are unguessable UUIDs and the route is
	// rate-limited + ETag-cached. Revisit after the images-module audit if threat
	// model changes.
	.get(
		"/:imageId",
		async ({ params, query, headers, request }) => {
			const width = query.width ?? query.w;
			const height = query.height ?? query.h;
			const quality = query.quality ?? query.q;

			const imageQuery: ImageQuery = { width, height, quality };
			const image = await imagesService.getOptimizedById(params.imageId, imageQuery, request.signal);

			return binaryFileResponse(image.file, image.contentType, IMAGE_CACHE_CONTROL, headers["if-none-match"]);
		},
		{
			rateLimit: {
				name: "image-optimization",
				max: 250,
				windowMs: 10_000,
			},
			cache: { maxAge: 86400, immutable: true },
			deduplicate: {},
			params: t.Object({
				imageId: t.String(),
			}),
			query: t.Object({
				width: t.Optional(t.Numeric({ minimum: 1, maximum: 4096 })),
				w: t.Optional(t.Numeric({ minimum: 1, maximum: 4096 })),
				height: t.Optional(t.Numeric({ minimum: 1, maximum: 4096 })),
				h: t.Optional(t.Numeric({ minimum: 1, maximum: 4096 })),
				quality: t.Optional(t.Numeric({ minimum: 1, maximum: 100 })),
				q: t.Optional(t.Numeric({ minimum: 1, maximum: 100 })),
			}),
			response: {
				// Binary image (or 304) — the handler returns a Response, which Elysia
				// sends as-is and never schema-validates. `t.Any()` is deliberate.
				200: t.Any(),
				304: t.Any(),
				404: "error.response",
			},
			detail: {
				description: "Retrieve an image file by its ID, with optional resizing support.",
			},
		},
	)
	.use(authMiddleware)
	.delete("/:imageId", async ({ params }) => await imagesService.delete(params.imageId), {
		adminOnly: true,
		params: t.Object({
			imageId: t.String(),
		}),
		response: { ...ROUTE_ERRORS.NOT_FOUND, 200: "success.response" },
		detail: {
			description: "Permanently remove an image and optionally its physical file from storage.",
		},
	});
