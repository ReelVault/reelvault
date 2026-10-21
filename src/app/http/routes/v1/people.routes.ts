import { PersonFiltersSchema, PersonSortingSchema, PersonWithRelationsSchema } from "@reelvault/sdk/common";
import { peopleService } from "@/app/catalog/people.service";
import { PersonIdParams } from "@/app/http/schemas/route-params.schema";
import { createRefreshableCatalogResourceRoutes } from "./shared/create-catalog-resource.routes";

export const peopleRoutes = createRefreshableCatalogResourceRoutes({
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
	refresh: {
		refresh: (id) => peopleService.refresh(id),
		refreshImage: (id) => peopleService.refreshImage(id),
		refreshMany: (ids) => peopleService.refreshMany(ids),
		descriptions: {
			refresh: "Refresh person details and download profile image if missing.",
			refreshImage: "Force download and replace person profile image.",
			refreshMany: "Refresh up to 50 people in turn. Each id reports its own outcome, so one failure does not stop the others.",
		},
	},
});
