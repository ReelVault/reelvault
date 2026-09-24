import Elysia from "elysia";
import { domainErrorsMiddleware } from "@/middleware/domain-errors.middleware";
import { adminRoutes } from "./admin/admin.routes";
import { v1Routes } from "./v1/v1.routes";

// The API router also runs detached from the root app: the web-static plugin
// re-dispatches `GET /v1/*` paths through `apiRouter.handle(request)` when the
// root wildcard outranks an API catch-all route. Without the error middleware
// on this instance, a thrown DomainError becomes a raw 500 that web-static
// passes through verbatim (bypassing the JSON envelope). Named-plugin
// deduplication keeps a single instance when the root app mounts it too.
export const apiRouter = new Elysia({ prefix: "/v1" }).use(domainErrorsMiddleware).use(v1Routes).use(adminRoutes);
