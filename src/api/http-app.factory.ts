import cors from "@elysiajs/cors";
import Elysia from "elysia";
import { isOriginAllowed } from "@/utils/origin-trust.utils";
import { clientIpMiddleware } from "./middleware/client-ip.middleware";
import { compressionMiddleware } from "./middleware/compression.middleware";
import { domainErrorsMiddleware } from "./middleware/domain-errors.middleware";
import { openapiMiddleware } from "./middleware/openapi.middleware";
import { rateLimitMiddleware } from "./middleware/rate-limit.middleware";
import { requestDedupMiddleware } from "./middleware/request-dedup.middleware";
import { requestLoggerMiddleware } from "./middleware/request-logger.middleware";
import { responseCacheMiddleware } from "./middleware/response-cache.middleware";
import { securityHeadersMiddleware } from "./middleware/security.middleware";
import { apiRouter } from "./routes/api.routes";
import { webStaticPlugin } from "./web/web-static.plugin";

interface HttpListenOptions {
	port: number;
	hostname: string;
	maxRequestBodySize: number;
	/** Seconds a socket may stay idle mid-request. */
	idleTimeout: number;
}

/** What the composition root does with the server: start it and stop it. */
export interface HttpApp {
	listen(options: HttpListenOptions, callback: () => void): void;
	stop(): Promise<void>;
}

/** The HTTP server: the middleware stack in its required order, the API router and the bundled web UI. */
export function createHttpApp(): HttpApp {
	// Setup Elysia — domainErrorsMiddleware catches DomainError subclasses and maps
	// them to structured API responses (400/401/403/404/409/408/429/500).
	//
	// encodeSchema: false skips Elysia's response-transform encoding. SDK entity
	// schemas carry `t.Date()` transforms, and running them over every uncached
	// payload costs CPU. `JSON.stringify` writes a Date as the same ISO string the
	// transform produces. Response validation and unknown-field stripping still run.
	// One difference: a number in a Date field now passes the response check and is
	// served as a number, where it used to fail with a 422. The response-cache hit
	// path has always served pre-serialized bodies without the transform.
	const app = new Elysia({ name: "ReelVault", aot: true, encodeSchema: false })
		.use(domainErrorsMiddleware)
		.use(securityHeadersMiddleware)
		.use(requestLoggerMiddleware)
		.use(requestDedupMiddleware)
		.use(responseCacheMiddleware)
		.use(compressionMiddleware)
		.use(
			cors({
				origin: (request) => isOriginAllowed(request.headers.get("origin")),
				methods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
				credentials: true,
				allowedHeaders: [
					"Content-Type",
					"Authorization",
					"Idempotency-Key",
					"x-requested-with",
					"x-profile-id",
					"x-setup-token",
					"x-api-key",
					"x-client-shell",
				],
				// Browser clients need explicit access to these non-simple response headers.
				exposeHeaders: ["ETag", "Retry-After", "X-RateLimit-Limit", "X-RateLimit-Remaining", "X-RateLimit-Reset"],
			}),
		)
		// Public API reference; OPENAPI_DOCS_ENABLED=false unregisters it entirely.
		.use(openapiMiddleware)
		// Must precede every consumer of the client IP (rate limiter, auth, audit).
		.use(clientIpMiddleware)
		.use(rateLimitMiddleware)
		.use(apiRouter)
		// After the API router: the wildcard serves the bundled web UI without ever
		// shadowing /v1 or /openapi (API paths yield to keep the JSON 404 envelope).
		.use(webStaticPlugin);

	return {
		listen: (options, callback) => {
			app.listen(options, callback);
		},
		stop: async () => {
			await app.stop();
		},
	};
}
