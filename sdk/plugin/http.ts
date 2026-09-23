import type { Static, TSchema } from "@sinclair/typebox";

export type PluginHttpMethod = "DELETE" | "GET" | "PATCH" | "POST" | "PUT";

/**
 * Route authorization levels (enforced by the host on every request):
 * - `"admin"` — requires the admin role;
 * - `"user"`  — any authenticated user (the plugin scopes resources itself).
 */
export type PluginRouteAccess = "admin" | "user";

export interface PluginHttpUser {
	id: string;
	role: string;
	profileId?: string | undefined;
}

export interface PluginHttpRequest<TBody = unknown, TQuery = Readonly<Record<string, string>>, TParams = Readonly<Record<string, string>>> {
	params: TParams;
	query: TQuery;
	headers?: Readonly<Record<string, string>> | undefined;
	body: TBody;
	user: PluginHttpUser;
}

export interface PluginHttpResponse {
	status?: number | undefined;
	headers?: Record<string, string> | undefined;
	body?: unknown;
}

/**
 * An inbound route registered by a plugin.
 *
 * `body`/`query`/`params` are TypeBox schemas — when present, the host validates
 * the request and hands the handler the parsed, statically-typed values.
 * `response` is optional; when omitted any serialisable body is returned as-is.
 */
export interface PluginHttpRoute<TBody = unknown, TQuery = Readonly<Record<string, string>>, TParams = Readonly<Record<string, string>>> {
	method: PluginHttpMethod;
	path: string;
	/** Defaults to `"user"`. */
	access?: PluginRouteAccess | undefined;
	body?: TSchema | undefined;
	query?: TSchema | undefined;
	params?: TSchema | undefined;
	response?: TSchema | undefined;
	handler(request: PluginHttpRequest<TBody, TQuery, TParams>): PluginHttpResponse | Promise<PluginHttpResponse>;
}

type StaticOr<TValue, TDefault> = TValue extends TSchema ? Static<TValue> : TDefault;

export interface RouteDefinition<
	TBody extends TSchema | undefined = undefined,
	TQuery extends TSchema | undefined = undefined,
	TParams extends TSchema | undefined = undefined,
> {
	method: PluginHttpMethod;
	path: string;
	access?: PluginRouteAccess | undefined;
	body?: TBody | undefined;
	query?: TQuery | undefined;
	params?: TParams | undefined;
	response?: TSchema | undefined;
	handler(
		request: PluginHttpRequest<
			StaticOr<TBody, unknown>,
			StaticOr<TQuery, Readonly<Record<string, string>>>,
			StaticOr<TParams, Readonly<Record<string, string>>>
		>,
	): PluginHttpResponse | Promise<PluginHttpResponse>;
}

/** Identity helper that carries the TypeBox schemas' static types into the handler. */
export function route<
	TBody extends TSchema | undefined = undefined,
	TQuery extends TSchema | undefined = undefined,
	TParams extends TSchema | undefined = undefined,
>(
	definition: RouteDefinition<TBody, TQuery, TParams>,
): PluginHttpRoute<
	StaticOr<TBody, unknown>,
	StaticOr<TQuery, Readonly<Record<string, string>>>,
	StaticOr<TParams, Readonly<Record<string, string>>>
> {
	return definition;
}

export function ok(body?: unknown, options?: { headers?: Record<string, string> }): PluginHttpResponse {
	if (options?.headers) return { status: 200, headers: options.headers, body };

	return { status: 200, body };
}

export function created(body?: unknown): PluginHttpResponse {
	return { status: 201, body };
}

export function fail(status: number, code: string, params?: Readonly<Record<string, unknown>>): PluginHttpResponse {
	return { status, body: { statusCode: status, code, ...(params ? { params } : {}) } };
}
