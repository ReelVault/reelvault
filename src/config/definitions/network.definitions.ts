import { env } from "@/env";
import { SystemSettingsCreator } from "../system-settings.utils";

function parseInitialOrigins(value?: string): string[] {
	if (!value) return [];

	return value
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
}

const creator = SystemSettingsCreator("network");

export const NETWORK_SETTINGS_DEFINITIONS = {
	"network.allowedOrigins": creator.stringArray("network.allowedOrigins", parseInitialOrigins(env.APP_ALLOWED_ORIGINS)),

	"network.trustLocalNetworks": creator.boolean("network.trustLocalNetworks", true),
} as const;
