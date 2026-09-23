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
					{ name: "Profiles", description: "User profile management and switching" },
					{ name: "Discover", description: "Home dashboard and content discovery" },
					{ name: "Search", description: "Global search across all content" },
					{ name: "Metadata", description: "Movies and TV show metadata" },
					{ name: "Movies", description: "Movie-specific data" },
					{ name: "Seasons", description: "TV show seasons" },
					{ name: "Episodes", description: "TV show episodes" },
					{ name: "People", description: "Cast and crew" },
					{ name: "Genres", description: "Genre management" },
					{ name: "Keywords", description: "Keyword management" },
					{ name: "Collections", description: "Movie/show collections" },
					{ name: "Libraries", description: "Media library configuration and scanning" },
					{ name: "Stream", description: "HLS streaming and playback" },
					{ name: "Subtitles", description: "Subtitle tracks" },
					{ name: "Continue Watching", description: "Playback position tracking" },
					{ name: "Notifications", description: "Account and profile notification inbox" },
					{ name: "Watched History", description: "Watch history per profile" },
					{ name: "Watchlist", description: "Personal watchlist" },
					{ name: "User Ratings", description: "User ratings for titles" },
					{ name: "Images", description: "Image serving and management" },
					{ name: "Providers", description: "External metadata providers (TMDB, etc.)" },
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
