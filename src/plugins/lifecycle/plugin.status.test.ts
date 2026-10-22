import { describe, expect, it } from "bun:test";
import { DomainError } from "@/utils/domain.errors";
import { pluginErrorCode } from "./plugin.status";

describe("pluginErrorCode", () => {
	it("keeps the code of a domain error", () => {
		expect(pluginErrorCode(new DomainError("validation", "bad", { code: "plugin.config_invalid" }), "config")).toBe(
			"plugin.config_invalid",
		);
	});

	it("reports plugin.manifest_invalid for a manifest failure even when the error carries another code", () => {
		expect(pluginErrorCode(new DomainError("validation", "bad", { code: "plugin.config_invalid" }), "manifest")).toBe(
			"plugin.manifest_invalid",
		);
	});

	it("classifies an uncoded manifest failure as plugin.manifest_invalid and an import failure as plugin.load_failed", () => {
		expect(pluginErrorCode(new DomainError("validation", "no json"), "manifest")).toBe("plugin.manifest_invalid");
		expect(pluginErrorCode(new Error("boom"), "import")).toBe("plugin.load_failed");
	});

	it("falls back to a generic load failure without a phase", () => {
		expect(pluginErrorCode("plain text")).toBe("plugin.load_failed");
	});
});
