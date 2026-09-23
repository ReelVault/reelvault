/**
 * ReelVault plugin UI SDK
 *
 * Plugin UI ships as **custom elements** (Web Components). One ESM module
 * (declared as `entry` in `ui.json`) registers every element the plugin uses;
 * the host imports it and mounts `<tag>` inline in the application document.
 *
 * Why custom elements instead of iframes: the element runs in the host
 * document — no iframe, no sandbox, no postMessage, no CSP/framing issues, and
 * it inherits CSS custom properties (theme tokens) while Shadow DOM keeps its
 * styles isolated.
 *
 * ```tsx
 * import { definePluginElement, mountShadow, type PluginUiHost } from "reelvault-sdk/ui";
 * import { createRoot } from "react-dom/client";
 * import css from "./styles.css?inline";
 * import { App } from "./app";
 *
 * definePluginElement("rv-example-panel", (element, host) => {
 *   const mount = mountShadow(element, css);
 *   createRoot(mount).render(<App host={host} />);
 * });
 * ```
 */
import type { PluginUiHost } from "../plugin/ui-host";

export type {
	PluginPlayerState,
	PluginUiApi,
	PluginUiApiCallOptions,
	PluginUiContext,
	PluginUiDeviceContext,
	PluginUiHost,
	PluginUiPlayerContext,
	PluginUiProfileContext,
	PluginUiToastLevel,
	PluginUiUserContext,
} from "../plugin/ui-host";

export { PLUGIN_UI_PROTOCOL_VERSION } from "../plugin/ui-host";

export type {
	PluginSchemaAction,
	PluginSchemaCondition,
	PluginSchemaDataSource,
	PluginSchemaField,
	PluginSchemaFieldNode,
	PluginSchemaNode,
	PluginSchemaValue,
	PluginUiSchemaSurface,
} from "../plugin/ui-schema";

export {
	alert,
	badge,
	button,
	card,
	checkboxField,
	dateField,
	defineSchema,
	embed,
	empty,
	foreach,
	grid,
	heading,
	list,
	numberField,
	row,
	secretField,
	section,
	selectField,
	separator,
	stack,
	stats,
	switchField,
	table,
	tabs,
	text,
	textareaField,
	textField,
	when,
} from "./schema";

/**
 * Registers a custom element and gives it the live host API when mounted.
 * Optionally returns a teardown function invoked on disconnect.
 */
export type PluginElementSetup = (element: HTMLElement, host: PluginUiHost) => (() => void) | undefined;

/**
 * Base class for plugin elements. The host assigns `element.reelvaultHost` and
 * `onHost` runs once the element is connected and the host is available (in
 * either order); `onTeardown` runs on disconnect and the element may re-mount.
 */
export abstract class ReelVaultElement extends HTMLElement {
	#host: PluginUiHost | null = null;
	#started = false;
	#teardown: (() => void) | undefined;

	set reelvaultHost(host: PluginUiHost | null) {
		this.#host = host;
		this.#maybeStart();
	}

	get reelvaultHost(): PluginUiHost | null {
		return this.#host;
	}

	connectedCallback(): void {
		this.#maybeStart();
	}

	disconnectedCallback(): void {
		this.#teardown?.();
		this.#teardown = undefined;
		this.#started = false;
	}

	#maybeStart(): void {
		if (this.#started || !this.#host || !this.isConnected) return;

		this.#started = true;
		const teardown = this.onHost(this.#host);
		this.#teardown = typeof teardown === "function" ? teardown : undefined;
	}

	protected abstract onHost(host: PluginUiHost): (() => void) | undefined;
}

/** Registers `tag`; it is safe to call more than once (idempotent). */
export function definePluginElement(tag: string, setup: PluginElementSetup): void {
	if (typeof customElements === "undefined" || customElements.get(tag)) return;

	customElements.define(
		tag,
		class extends ReelVaultElement {
			protected onHost(host: PluginUiHost): (() => void) | undefined {
				return setup(this, host);
			}
		},
	);
}

/**
 * Attaches an open shadow root (once), optionally injects the plugin's CSS and
 * returns the element the plugin should render into. The host's CSS custom
 * properties inherit into the shadow root, so `var(--background)` etc. work.
 */
export function mountShadow(element: HTMLElement, cssText?: string): HTMLElement {
	const shadow = element.shadowRoot ?? element.attachShadow({ mode: "open" });
	if (cssText && !shadow.querySelector("style[data-reelvault]")) {
		const style = document.createElement("style");
		style.dataset.reelvault = "";
		style.textContent = cssText;
		shadow.append(style);
	}

	const existing = shadow.querySelector<HTMLElement>("[data-reelvault-mount]");
	if (existing) return existing;

	const mount = document.createElement("div");
	mount.dataset.reelvaultMount = "";
	shadow.append(mount);

	return mount;
}
