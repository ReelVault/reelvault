import { createProfileMetadataLink } from "../utils/junction";
import { metadata } from "./metadata.schema";
import { profiles } from "./profiles.schema";

export const watchlist = createProfileMetadataLink("watchlist", { profileId: () => profiles.id, metadataId: () => metadata.id }, {});
