# Standalone Pi Mate runtime.
#
# The runtime is a separately restartable executor generation: it connects to
# an externally managed Rivet Engine and owns no durable state, so this image
# is intentionally stateless and safe to replace at will.
#
# The build stages a single-file esbuild bundle plus the rivetkit-napi addon
# (the one native dependency, which cannot be bundled). Everything else the
# Mate needs — rivetkit, the @rivet-dev/pi integration, the Pi coding agent,
# hono — is compiled into the bundle, which keeps the image small and free of
# the monorepo's full node_modules.
FROM node:22-slim

RUN apt-get update -qq \
    && apt-get install -y --no-install-recommends tini curl \
    && rm -rf /var/lib/apt/lists/* \
    && addgroup --system mate && adduser --system --ingroup mate mate

WORKDIR /app
COPY --chown=mate:mate mate-runtime.mjs ./mate-runtime.mjs
COPY --chown=mate:mate node_modules/ ./node_modules/

USER mate
# 6423 serves /health, /ready, /metrics, and the RivetKit handler routes.
EXPOSE 6423

ENV HOST=0.0.0.0 PORT=6423 NODE_ENV=production
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=5 \
  CMD curl -fsS http://127.0.0.1:6423/ready || exit 1

ENTRYPOINT ["/usr/bin/tini", "--", "node", "mate-runtime.mjs"]
