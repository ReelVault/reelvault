import { describe, expect, test } from "bun:test";
import { pluginManager } from "@/plugins/lifecycle/plugin.manager";
import { stubMethod } from "../../../tests/helpers/method-stub.helper";
import { adminService } from "./admin.service";

/**
 * A plugin's configuration moves between installations as a file. Secret fields never leave the server
 * in an export and are never overwritten by an import; a reset clears only the keys it names.
 */

const details = {
	id: "org.reelvault.config-io",
	config: { region: "eu", apiKey: "stored-secret" },
	fields: [
		{ name: "region", type: "string" as const },
		{ name: "apiKey", type: "secret" as const },
	],
};

describe("admin plugin configuration", () => {
	test("an export carries every non-secret value in the versioned format", async () => {
		const restore = stubMethod(pluginManager, "getPluginConfigDetails", () => Promise.resolve(details));
		try {
			expect(await adminService.exportPluginConfig("org.reelvault.config-io")).toEqual({
				format: "reelvault.plugin-config",
				formatVersion: 1,
				pluginId: "org.reelvault.config-io",
				values: details.config,
			});
		} finally {
			restore.restore();
		}
	});

	test("an import for another plugin is refused before anything is saved", async () => {
		const save = stubMethod(pluginManager, "savePluginConfig", () => Promise.resolve(details));
		try {
			await expect(
				adminService.importPluginConfig("org.reelvault.config-io", {
					format: "reelvault.plugin-config",
					formatVersion: 1,
					pluginId: "org.reelvault.other",
					values: { region: "us" },
				}),
			).rejects.toMatchObject({ code: "plugin.config_import_mismatch" });
			expect(save.calls.length).toBe(0);
		} finally {
			save.restore();
		}
	});

	test("an import saves the listed values but never a secret field from the file", async () => {
		const read = stubMethod(pluginManager, "getPluginConfigDetails", () => Promise.resolve(details));
		const save = stubMethod(pluginManager, "savePluginConfig", () => Promise.resolve(details));
		try {
			await adminService.importPluginConfig("org.reelvault.config-io", {
				format: "reelvault.plugin-config",
				formatVersion: 1,
				pluginId: "org.reelvault.config-io",
				values: { region: "us", apiKey: "attacker-value" },
			});

			expect(save.calls[0]?.[1]).toEqual({ region: "us" });
		} finally {
			read.restore();
			save.restore();
		}
	});
});
