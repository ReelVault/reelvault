import { PersonFiltersSchema, PersonSortingSchema, PersonWithRelationsSchema } from "@reelvault/sdk/common";
import { ROUTE_ERRORS } from "@/api/schemas/common.schemas";
import { PersonIdParams } from "@/api/schemas/route-params";
import { peopleService } from "@/application/catalog/people.service";
import { MINUTE } from "@/server.constants";
import { createCatalogResourceRoutes } from "./shared/create-catalog-resource-routes";

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
	});
