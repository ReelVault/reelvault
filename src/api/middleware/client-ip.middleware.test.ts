import { describe, expect, test } from "bun:test";
import Elysia from "elysia";
import { clientIpMiddleware } from "@/api/middleware/client-ip.middleware";
import { CLIENT_IP_HEADER } from "@/utils/client-ip.utils";

describe("clientIpMiddleware", () => {
	test("strips a client-supplied trusted header instead of honouring it", async () => {
		const app = new Elysia().use(clientIpMiddleware).get("/ip", ({ request }) => request.headers.get(CLIENT_IP_HEADER) ?? "none");

		const response = await app.handle(new Request("http://localhost/ip", { headers: { [CLIENT_IP_HEADER]: "1.2.3.4" } }));

		// No socket in app.handle, so nothing trustworthy can be stamped either.
		expect(await response.text()).toBe("none");
	});
});
