import { expect, test } from "bun:test";
import { CompaniesClient, ReelVaultClient } from "@reelvault/sdk/client";

test("companies client executes query operations against /companies endpoint", async () => {
	const requestedUrls: string[] = [];
	const client = new ReelVaultClient({
		baseUrl: "https://reelvault.test/v1",
		enableRetry: false,
		fetcher: (url, init) => {
			requestedUrls.push(`${init?.method ?? "GET"} ${String(url)}`);

			return Promise.resolve(
				new Response(
					JSON.stringify({
						id: "comp-123",
						name: "Warner Bros",
						originCountry: "US",
					}),
					{ headers: { "content-type": "application/json" } },
				),
			);
		},
	});

	expect(client.companies).toBeInstanceOf(CompaniesClient);

	const company = await client.companies.getById("comp-123");
	expect(company).toMatchObject({ id: "comp-123", name: "Warner Bros" });

	await client.companies.getMetadata("comp-123", { limit: 5 });

	expect(requestedUrls).toEqual([
		"GET https://reelvault.test/v1/companies/comp-123",
		"GET https://reelvault.test/v1/companies/comp-123/metadata?limit=5",
	]);
});
