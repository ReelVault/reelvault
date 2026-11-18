import { expect, test } from "bun:test";
import { GIB, KIB, MIB } from "./bytes.utils";

test("binary byte units hold their canonical values", () => {
	expect([KIB, MIB, GIB]).toEqual([1024, 1048576, 1073741824]);
});
