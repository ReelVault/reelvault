import { join } from "node:path";
import { env } from "@/config/env.config";
import { SystemSettingsCreator } from "@/config/system-settings.utils";

const creator = SystemSettingsCreator("system");

export const PATHS_SETTINGS_DEFINITIONS = {
	"paths.transcodes": creator.string("paths.transcodes", join(env.ROOT_DIR, "transcodes")),
	"paths.downloads": creator.string("paths.downloads", join(env.ROOT_DIR, "downloads")),
	"paths.backups": creator.string("paths.backups", join(env.ROOT_DIR, "backups")),
} as const;
