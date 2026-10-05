import openapi from "@elysiajs/openapi";
import Elysia from "elysia";
import { serverConfig } from "@/server.config";

/**
 * Interactive API reference at `/openapi`. Public by design (the spec is the
 * contract for external integrations); `OPENAPI_DOCS_ENABLED=false` removes
 * the route entirely on deployments that do not want the surface enumerated.
 */
export const openapiMiddleware = new Elysia({ name: "OpenAPI" });

if (serverConfig.api.openapi.enabled) {
	openapiMiddleware.use(
		openapi({
			path: serverConfig.api.openapi.path,
			documentation: {
				info: {
					title: serverConfig.api.openapi.title,
					description: serverConfig.api.openapi.description,
					version: serverConfig.api.openapi.version,
				},
				tags: [
					{ name: "Auth", description: "Authentication and session management" },
					{ name: "TwoFactor", description: "Two-factor authentication" },
					{ name: "Setup", description: "First-run server setup and administrator creation" },
					{ name: "Profiles", description: "User profile management and switching" },
					{ name: "Discover", description: "Home dashboard and content discovery" },
					{ name: "Downloads", description: "Offline download jobs" },
					{ name: "My Profile & Playback", description: "Current account, playback progress, watchlist and history" },
					{ name: "Metadata", description: "Movies and TV show metadata" },
					{ name: "Seasons", description: "TV show seasons" },
					{ name: "Episodes", description: "TV show episodes" },
					{ name: "People", description: "Cast and crew" },
					{ name: "Genres", description: "Genre management" },
					{ name: "Keywords", description: "Keyword management" },
					{ name: "Collections", description: "Movie/show collections" },
					{ name: "Companies", description: "Production companies" },
					{ name: "Libraries", description: "Media library configuration and scanning" },
					{ name: "Media Files", description: "Media file management and stream inspection" },
					{ name: "Playback Sessions", description: "HLS playback session lifecycle" },
					{ name: "Subtitles", description: "Subtitle tracks" },
					{ name: "Notifications", description: "Account and profile notification inbox" },
					{ name: "Images", description: "Image serving and management" },
					{ name: "Providers", description: "External metadata providers (TMDB, etc.)" },
					{ name: "Plugins", description: "Plugin management and configuration" },
					{ name: "Plugin UI", description: "Plugin UI asset serving" },
					{ name: "Admin", description: "Server administration and diagnostics" },
					{ name: "Health", description: "Server health check" },
				],
				components: {
					securitySchemes: {
						cookieAuth: {
							type: "apiKey",
							in: "cookie",
							name: "better-auth.session_token",
							description: "Session cookie set by the auth endpoint",
						},
						profileHeader: {
							type: "apiKey",
							in: "header",
							name: "x-profile-id",
							description: "Optional profile ID header (alternative to cookie)",
						},
					},
				},
				security: [{ cookieAuth: [] }],
			},
		}),
	);
}
