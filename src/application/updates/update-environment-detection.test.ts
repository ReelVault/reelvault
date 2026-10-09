import { describe, expect, test } from "bun:test";
import { detectContainerRuntime, isRootlessMarker } from "./update-environment";

describe("detectContainerRuntime", () => {
	test("recognizes a Docker container by its marker", () => {
		expect(detectContainerRuntime((path) => path === "/.dockerenv")).toBe("docker");
	});

	test("recognizes a Podman container by its marker", () => {
		expect(detectContainerRuntime((path) => path === "/run/.containerenv")).toBe("podman");
	});

	test("prefers Docker when both markers exist", () => {
		expect(detectContainerRuntime(() => true)).toBe("docker");
	});

	test("reports no container on a bare host", () => {
		expect(detectContainerRuntime(() => false)).toBeNull();
	});
});

describe("isRootlessMarker", () => {
	test("reads rootless=1 from the Podman marker", () => {
		expect(isRootlessMarker('engine="podman-5.0.0"\nrootless=1\nname="reelvault"\n')).toBe(true);
	});

	test("treats a rootful container as not rootless", () => {
		expect(isRootlessMarker('engine="podman-5.0.0"\nrootless=0\n')).toBe(false);
	});

	test("does not match a key that only ends in the same text", () => {
		expect(isRootlessMarker("notrootless=1")).toBe(false);
	});
});
