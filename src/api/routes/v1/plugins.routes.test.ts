import { expect, test } from "bun:test";
import { pluginsRoutes } from "./plugins.routes";

test("plugin routes expose the application dispatch boundary", () => {
	expect(pluginsRoutes.routes.some((route) => route.path === "/plugins/:pluginId/*")).toBe(true);
});
