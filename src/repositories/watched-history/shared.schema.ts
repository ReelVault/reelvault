import { defineTableAccess } from "@/integrations/drizzle-orm/query/table-access/table-access.factory";

export const watchedHistory = defineTableAccess("watchedHistory", {
	primaryKeyColumn: "id",
});
