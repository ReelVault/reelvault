/**
 * Host contract shared with plugin custom elements.
 *
 * Plugin UI runs inside the host document (same origin) as a Web Component, so
 * there is no postMessage bridge: the host assigns a live `PluginUiHost` object
 * to the element's `reelvaultHost` property and the element talks to the host
 * directly.
 */

/** Version of the host context/host API contract handed to plugin elements. */
export const PLUGIN_UI_PROTOCOL_VERSION = 2;

export interface PluginUiUserContext {
	id: string;
	role: string;
	name?: string | undefined;
}

export interface PluginUiProfileContext {
	id: string;
	name: string;
}

export interface PluginUiPlayerContext {
	currentTime?: number | undefined;
	duration?: number | undefined;
	mediaFileId?: string | undefined;
}

/** Ambient device/browser info the host shares with plugin surfaces. */
export interface PluginUiDeviceContext {
	userAgent?: string | undefined;
	language?: string | undefined;
	screenResolution?: string | undefined;
	browser?: string | undefined;
	os?: string | undefined;
}

/** Live playback state a plugin surface can request from the host. */
export type PluginPlayerState = PluginUiPlayerContext;

/** Ambient data the host shares with a mounted plugin surface. */
export interface PluginUiContext {
	protocolVersion: number;
	pluginId: string;
	/** Page id when the surface is a page or tab. */
	page?: string | undefined;
	/** Dialog id when the surface is a dialog. */
	dialog?: string | undefined;
	/** Route params supplied by the triggering contribution. */
	params: Record<string, string>;
	locale: string;
	theme: "light" | "dark";
	apiBaseUrl: string;
	/** Full current page URL (for context capture, e.g. bug reports). */
	pageUrl?: string | undefined;
	user?: PluginUiUserContext | undefined;
	profile?: PluginUiProfileContext | undefined;
	player?: PluginUiPlayerContext | undefined;
	device?: PluginUiDeviceContext | undefined;
}

export type PluginUiToastLevel = "success" | "error" | "info";

export interface PluginUiApiCallOptions {
	method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | undefined;
	query?: Record<string, string> | undefined;
	body?: unknown;
}

export interface PluginUiApi {
	/** Calls one of the plugin's own backend routes (`/v1/plugins/<id>/<path>`). */
	call<TResult = unknown>(path: string, options?: PluginUiApiCallOptions): Promise<TResult>;
}

/** Everything a plugin element can do through the host. */
export interface PluginUiHost {
	readonly protocolVersion: number;
	readonly pluginId: string;
	/** Current ambient context (updated live; subscribe via `onContext`). */
	readonly context: PluginUiContext;
	readonly api: PluginUiApi;
	/** Navigate the host application to an in-app path. */
	navigate(to: string): void;
	/** Open one of the plugin's dialogs, optionally with extra params. */
	openDialog(dialog: string, params?: Record<string, string>): void;
	/** Close the host surface containing this element (dialogs). */
	close(): void;
	toast(level: PluginUiToastLevel, message: string): void;
	/** Live playback state (empty object when no player is mounted). */
	getPlayerState(): PluginPlayerState;
	/** Seek the host player to an absolute position in seconds. */
	seek(time: number): void;
	onContext(listener: (context: PluginUiContext) => void): () => void;
	/** Subscribe to a host realtime event; returns an unsubscribe function. */
	onEvent(event: string, listener: (payload: unknown) => void): () => void;
}
