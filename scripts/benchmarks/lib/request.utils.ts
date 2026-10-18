/** JSON mutation request shared by the write suites (content-type only when a body exists). */
export function jsonRequest(
	url: string,
	method: "POST" | "PUT" | "PATCH" | "DELETE",
	headers: Record<string, string>,
	body?: unknown,
): Request {
	return new Request(url, {
		method,
		headers: body === undefined ? headers : { ...headers, "content-type": "application/json" },
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
	});
}
