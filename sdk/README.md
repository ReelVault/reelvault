# reelvault-sdk

Typed TypeScript SDK for [ReelVault](https://github.com/ReelVault/ReelVault.Server) — a self-hosted media server. It is the single source of truth for every request/response shape, the typed HTTP client, the server-side plugin host and the plugin UI kit.

## Install

```bash
bun add reelvault-sdk
# or: npm install reelvault-sdk
```

## Entry points

| Import | What you get |
|---|---|
| `reelvault-sdk` | Root — re-exports the client, validation errors and all shared contracts |
| `reelvault-sdk/client` | Typed HTTP client (`ReelVaultClient`) and its resource clients |
| `reelvault-sdk/common` | Shared request/response contracts — TypeBox schemas and their inferred types |
| `reelvault-sdk/plugin` | Server-side plugin SDK — `definePlugin`, `PluginHost` and every plugin contract |
| `reelvault-sdk/ui` | Client-side UI kit — custom elements, `mountShadow`, schema builders |
| `reelvault-sdk/ui/schema` | Just the declarative schema builders (tree-shakeable) |
| `reelvault-sdk/testing` | `PluginTestHost` — an in-memory plugin host for unit tests |

Every entry point ships dual-format (ESM + CJS) with full `.d.ts` declarations.

## Usage

### API client

```ts
import { ReelVaultClient } from "reelvault-sdk/client";

const client = new ReelVaultClient({ baseUrl: "http://localhost:3030" });
await client.auth.login({ email, password });
const movies = await client.media.listMovies({ page: 1 });
```

### Shared contract types

```ts
import type { MovieDetail, RealtimeEventMap } from "reelvault-sdk/common";
```

### Plugin

```ts
import { definePlugin } from "reelvault-sdk/plugin";

export default definePlugin({
	async setup(host) {
		host.logger.info("plugin ready");
	},
});
```

## Documentation

- SDK overview and API reference: <https://reelvault.org/sdk/>
- Plugin authoring: <https://reelvault.org/plugins/getting-started>
