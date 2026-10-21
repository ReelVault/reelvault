import Elysia from "elysia";
import { domainErrorsMiddleware } from "@/api/middleware/domain-errors.middleware";
import { adminRoutes } from "./admin/admin.routes";
import { v1Routes } from "./v1/v1.routes";

// The API router carries the error middleware so a DomainError raised in a
// route answers with the JSON envelope even when the router is reached on its
// own rather than through the root app.
export const apiRouter = new Elysia({ prefix: "/v1" }).use(domainErrorsMiddleware).use(v1Routes).use(adminRoutes);
