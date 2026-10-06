import type { RemoteAccessCheck, RemoteAccessDiagnostics } from "@reelvault/sdk/common";
import { env } from "@/env";
import { serverConfig } from "@/server.config";
import { BaseService } from "@/utils/base-service";

const TRAILING_SLASH_RE = /\/$/;
const HTTP_URL_RE = /^https?:\/\//;

/**
 * Remote-access setup wizard data: configuration checks plus ready-to-paste
 * reverse-proxy snippets. Remote access itself is intentionally proxy-based —
 * the server ships no TLS and no automatic UPnP exposure.
 */
class RemoteAccessService extends BaseService {
	constructor() {
		super("RemoteAccessService");
	}

	async getDiagnostics(): Promise<RemoteAccessDiagnostics> {
		const trimmedUrl = env.APP_PUBLIC_URL?.trim();
		const publicUrl = trimmedUrl === undefined || trimmedUrl === "" ? null : trimmedUrl;
		const checks: RemoteAccessCheck[] = [];

		checks.push(
			publicUrl
				? { id: "public-url", ok: true, code: "remote_access.public_url_set", params: { publicUrl } }
				: { id: "public-url", ok: false, code: "remote_access.public_url_missing" },
		);

		const isHttps = Boolean(publicUrl?.startsWith("https://"));
		if (!publicUrl) checks.push({ id: "https", ok: null, code: "remote_access.https_no_public_url" });
		else if (isHttps) checks.push({ id: "https", ok: true, code: "remote_access.https_enabled" });
		else checks.push({ id: "https", ok: false, code: "remote_access.https_disabled" });

		const bindHost = serverConfig.network.host;
		const loopbackBind = bindHost === "127.0.0.1" || bindHost === "localhost";

		checks.push(
			loopbackBind
				? { id: "bind-host", ok: null, code: "remote_access.bind_loopback" }
				: { id: "bind-host", ok: publicUrl ? true : null, code: "remote_access.bind_external", params: { bindHost } },
		);

		const trustedProxyCount = env.APP_TRUSTED_PROXY_COUNT;
		checks.push(
			trustedProxyCount > 0
				? { id: "trusted-proxy", ok: true, code: "remote_access.trusted_proxy_set", params: { count: trustedProxyCount } }
				: { id: "trusted-proxy", ok: publicUrl ? null : true, code: "remote_access.trusted_proxy_missing" },
		);

		const reachable = publicUrl ? await this.checkSelfReachable(publicUrl) : null;
		if (reachable === null) checks.push({ id: "reachable", ok: null, code: "remote_access.reachable_not_configured" });
		else if (reachable.ok) checks.push({ id: "reachable", ok: true, code: "remote_access.reachable_ok" });
		else checks.push({ id: "reachable", ok: false, code: "remote_access.reachable_failed" });

		return {
			publicUrl,
			bindHost,
			checks,
			generated: {
				caddy: this.buildCaddyfile(publicUrl),
				nginx: this.buildNginxConfig(publicUrl),
				env: this.buildEnvSnippet(publicUrl),
			},
		};
	}

	private async checkSelfReachable(publicUrl: string): Promise<{ ok: boolean } | null> {
		try {
			const response = await fetch(`${publicUrl.replace(TRAILING_SLASH_RE, "")}/v1/health`, {
				signal: AbortSignal.timeout(5000),
			});

			return { ok: response.ok };
		} catch {
			return { ok: false };
		}
	}

	private hostPort(): { host: string; port: string } {
		return { host: "127.0.0.1", port: String(env.APP_PORT) };
	}

	private buildCaddyfile(publicUrl: string | null): string {
		const host = publicUrl ? publicUrl.replace(HTTP_URL_RE, "").replace(TRAILING_SLASH_RE, "") : "tv.example.com";
		const { host: bindHost, port } = this.hostPort();

		return `${host} {
	# Automatic HTTPS (Caddy obtains the certificate itself)
	reverse_proxy ${bindHost}:${port}
}`;
	}

	private buildNginxConfig(publicUrl: string | null): string {
		const host = publicUrl ? publicUrl.replace(HTTP_URL_RE, "").replace(TRAILING_SLASH_RE, "") : "tv.example.com";
		const { port } = this.hostPort();

		return `# TLS: certificate e.g. via certbot --nginx
server {
	listen 443 ssl;
	server_name ${host};

	location / {
		proxy_pass http://127.0.0.1:${port};
		proxy_set_header Host $host;
		proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
		proxy_set_header X-Forwarded-Proto $scheme;
		# HLS: allow more time for the first segment
		proxy_read_timeout 120s;
	}
}`;
	}

	private buildEnvSnippet(publicUrl: string | null): string {
		const { port } = this.hostPort();
		const url = publicUrl ?? "https://tv.example.com";

		return `APP_PUBLIC_URL=${url}
APP_TRUSTED_PROXY_COUNT=1
APP_HOST=127.0.0.1   # the server stays local; the outside world comes in through the proxy
# APP_PORT=${port}`;
	}
}

export const remoteAccessService = new RemoteAccessService();
