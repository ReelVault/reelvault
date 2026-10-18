import { createProfileMetadataLink } from "@/integrations/drizzle-orm/utils/junction.utils";
import { metadata } from "./metadata.schema";
import { profiles } from "./profiles.schema";

export const watchlist = createProfileMetadataLink("watchlist", { profileId: () => profiles.id, metadataId: () => metadata.id }, {});
