import { describe, expect, it } from "bun:test";
import { DomainError } from "@/utils/errors";
import { pluginErrorCode } from "./plugin.status";

describe("pluginErrorCode", () => {
	it("keeps the code of a domain error", () => {
		expect(pluginErrorCode(new DomainError("validation", "bad", { code: "plugin.config_invalid" }), "config")).toBe(
			"plugin.config_invalid",
		);
	});

	it("classifies an uncoded error by the phase that failed", () => {
		expect(pluginErrorCode(new DomainError("validation", "no json"), "manifest")).toBe("plugin.manifest_invalid");
		expect(pluginErrorCode(new Error("boom"), "import")).toBe("plugin.load_failed");
	});

	it("falls back to a generic load failure without a phase", () => {
		expect(pluginErrorCode("plain text")).toBe("plugin.load_failed");
	});
});
