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

	// TODO: This must not be server-side text
	async getDiagnostics(): Promise<RemoteAccessDiagnostics> {
		const trimmedUrl = env.APP_PUBLIC_URL?.trim();
		const publicUrl = trimmedUrl === undefined || trimmedUrl === "" ? null : trimmedUrl;
		const checks: RemoteAccessCheck[] = [];

		checks.push({
			id: "public-url",
			ok: Boolean(publicUrl),
			title: "Public address (APP_PUBLIC_URL)",
			detail: publicUrl
				? `Set to: ${publicUrl}`
				: "Set APP_PUBLIC_URL, e.g. https://tv.example.com — without it, remote clients and cookies will not work correctly.",
		});

		const isHttps = Boolean(publicUrl?.startsWith("https://"));
		let httpsDetail: string;
		if (!publicUrl) httpsDetail = "Enable HTTPS through a reverse proxy when you expose the server outside your home.";
		else if (isHttps) httpsDetail = "The connection is encrypted — login and password are protected.";
		else
			httpsDetail = "Remote access without HTTPS sends the password in clear text. Set up a reverse proxy with a certificate (e.g. Caddy).";

		checks.push({
			id: "https",
			ok: publicUrl ? isHttps : null,
			title: "HTTPS",
			detail: httpsDetail,
		});

		const bindHost = serverConfig.network.host;
		const loopbackBind = bindHost === "127.0.0.1" || bindHost === "localhost";
		let bindOk: boolean | null = null;
		if (publicUrl && !loopbackBind) bindOk = true;

		checks.push({
			id: "bind-host",
			ok: bindOk,
			title: "Server binding",
			detail: loopbackBind
				? "The server listens on 127.0.0.1 — behind a reverse proxy on the same machine that is correct and safe. To expose the port directly, set APP_HOST=0.0.0.0 (not recommended without TLS)."
				: `The server listens on ${bindHost}.`,
		});

		checks.push({
			id: "trusted-proxy",
			ok: env.APP_TRUSTED_PROXY_COUNT > 0 || !publicUrl ? true : null,
			title: "Trusted proxies (APP_TRUSTED_PROXY_COUNT)",
			detail:
				env.APP_TRUSTED_PROXY_COUNT > 0
					? `Set to ${env.APP_TRUSTED_PROXY_COUNT} — rate limits and the audit log will see real client addresses.`
					: "Behind a reverse proxy, set APP_TRUSTED_PROXY_COUNT=1; otherwise the rate limiter sees proxy addresses, not clients.",
		});

		const reachable = publicUrl ? await this.checkSelfReachable(publicUrl) : null;
		let reachableDetail: string;
		if (reachable === null) reachableDetail = "Set APP_PUBLIC_URL to test reachability.";
		else if (reachable.ok) reachableDetail = "The server responds at the public address.";
		else
			reachableDetail =
				"The server did not respond at the public address. Check port forwarding, firewall and DNS (note: this test runs from the server itself — with NAT hairpinning, also verify from outside, e.g. from a phone on mobile data).";

		checks.push({
			id: "reachable",
			ok: reachable === null ? null : reachable.ok,
			title: "Internet reachability",
			detail: reachableDetail,
		});

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
