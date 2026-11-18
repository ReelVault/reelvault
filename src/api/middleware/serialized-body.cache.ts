/**
 * Shares the JSON serialization of a response body between the response-cache
 * (ETag), compression and request-dedup middlewares, so a large cached JSON
 * body is serialized at most once per request.
 */
export const serializedBodyCache = new WeakMap<object, string>();
