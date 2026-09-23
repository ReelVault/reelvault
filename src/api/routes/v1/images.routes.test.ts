import { expect, test } from "bun:test";
import { imagesRoutes } from "./images.routes";

test("images routes compile successfully", () => {
	expect(() => imagesRoutes.compile()).not.toThrow();
});
