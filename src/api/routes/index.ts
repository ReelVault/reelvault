import Elysia from "elysia";
import { adminRoutes } from "./admin/admin.routes";
import { v1Routes } from "./v1/v1.routes";

export const apiRouter = new Elysia({ prefix: "/v1" }).use(v1Routes).use(adminRoutes);
