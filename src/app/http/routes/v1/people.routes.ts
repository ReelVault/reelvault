import {
	BulkRefreshBodySchema,
	BulkRefreshResultSchema,
	PersonFiltersSchema,
	PersonSortingSchema,
	PersonWithRelationsSchema,
} from "@reelvault/sdk/common";
import { peopleService } from "@/app/catalog/people.service";
import { ROUTE_ERRORS } from "@/app/http/schemas/common.schema";
import { PersonIdParams } from "@/app/http/schemas/route-params.schema";
import { MINUTE } from "@/config/server/server.constants";
import { createCatalogResourceRoutes } from "./shared/create-catalog-resource.routes";

export const peopleRoutes = createCatalogResourceRoutes({
	prefix: "/people",
	tag: "People",
	name: "person",
	service: peopleService,
	entity: PersonWithRelationsSchema,
	filters: PersonFiltersSchema,
	sorting: PersonSortingSchema,
	params: PersonIdParams,
	cacheMaxAge: { list: 60, detail: 120 },
	descriptions: {
		list: "Retrieve a paginated list of people (cast and crew members).",
		detail: "Retrieve detailed information about a specific person by their ID.",
	},
})
	.post("/:personId/refresh", async ({ params }) => await peopleService.refresh(params.personId), {
		adminOnly: true,
		rateLimit: {
			name: "person-refresh",
			max: 30,
			windowMs: MINUTE,
		},
		params: PersonIdParams,
		response: { ...ROUTE_ERRORS.ADMIN_NOT_FOUND, 200: "person.schema" },
		detail: {
			description: "Refresh person details and download profile image if missing.",
		},
	})
	.post("/:personId/refresh-image", async ({ params }) => await peopleService.refreshImage(params.personId), {
		adminOnly: true,
		rateLimit: {
			name: "person-refresh-image",
			max: 30,
			windowMs: MINUTE,
		},
		params: PersonIdParams,
		response: { ...ROUTE_ERRORS.ADMIN_NOT_FOUND, 200: "person.schema" },
		detail: {
			description: "Force download and replace person profile image.",
		},
	})
	.post("/bulk-refresh", async ({ body }) => await peopleService.refreshMany(body.ids), {
		adminOnly: true,
		rateLimit: {
			name: "person-bulk-refresh",
			max: 30,
			windowMs: MINUTE,
		},
		body: BulkRefreshBodySchema,
		response: { ...ROUTE_ERRORS.VALIDATED_ADMIN, 200: BulkRefreshResultSchema },
		detail: {
			description: "Refresh up to 50 people in turn. Each id reports its own outcome, so one failure does not stop the others.",
		},
	});
