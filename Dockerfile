# syntax=docker/dockerfile:1
#
# All-in-one image: API + web UI + ffmpeg on port 3030.
#
#   docker buildx build --build-context website=../website -t reelvault/server .
#
# The `website` context is a checkout of ReelVault/website; the client is built
# inside the image (no bun link, no sibling-state dependency at runtime).

# ── Stage 1 — server source + dependencies ──────────────────────────────────
FROM docker.io/oven/bun:1 AS server
WORKDIR /app
COPY package.json bun.lock ./
# The image has no git; drop the prepare hook (lefthook) for image builds only.
RUN sed -i '\#"prepare":#d' package.json
# @reelvault/sdk comes from the npm registry like any other dependency.
RUN bun install --frozen-lockfile
COPY . .

# ── Stage 2 — web client build ───────────────────────────────────────────────
FROM docker.io/oven/bun:1 AS web
WORKDIR /website
COPY --from=website ./package.json ./
COPY --from=website ./bun.lock ./
COPY --from=website ./bunfig.toml ./
COPY --from=website . .
# The image has no git; drop the prepare hook (lefthook) for image builds only.
RUN sed -i '\#"prepare":#d' package.json
# A dev checkout can carry node_modules with symlinks into the Bun cache —
# always install fresh from the lockfile.
RUN rm -rf node_modules && bun install --frozen-lockfile
RUN bun run build

# ── Stage 3 — runtime: API + web UI + ffmpeg, single process, single port ──
FROM docker.io/oven/bun:1 AS runtime
# ffmpeg/ffprobe drive transcoding, trickplay and media analyses
RUN apt-get update \
	&& apt-get install -y --no-install-recommends ffmpeg \
	&& rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
	APP_PORT=3030 \
	APP_HOST=0.0.0.0 \
	ROOT_DIR=/data \
	APP_WEB_DIST=/web

WORKDIR /app
COPY --from=server /app /app
COPY --from=web /website/dist /web

RUN mkdir -p /data /web && chown -R bun:bun /data /app /web
USER bun

VOLUME /data
EXPOSE 3030

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
	CMD bun -e "fetch('http://127.0.0.1:'+(process.env.APP_PORT??'3030')+'/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["bun", "run", "src/index.ts"]
