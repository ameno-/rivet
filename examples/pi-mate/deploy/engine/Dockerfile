# Rivet Engine for the standalone Pi Mate.
#
# The Engine is the durable host: it owns actor scheduling, routing, and
# persistence, so the Mate runtime process is only the current executor
# generation and can be restarted at will. The binary is the published
# `@rivetkit/engine-cli-linux-x64-musl` artefact: a statically linked musl
# build, which is why this image is Alpine.
#
# Version is pinned by the artefact, not by this file; the build script
# records the version in the image label.
FROM alpine:3.20

RUN apk add --no-cache curl tini \
    && addgroup -S rivet && adduser -S -G rivet rivet \
    && mkdir -p /var/lib/rivet-engine && chown -R rivet:rivet /var/lib/rivet-engine

COPY rivet-engine /usr/bin/rivet-engine
RUN chmod +x /usr/bin/rivet-engine && /usr/bin/rivet-engine --version

# The Engine's own durable state. Mount a volume here; losing it loses every
# actor, including every Mate Pi session.
VOLUME ["/var/lib/rivet-engine"]

USER rivet
# 6420 serves the client API and the runtime's websocket connections;
# 6421 is the peer/health port the readiness probe uses.
EXPOSE 6420 6421

ENV RIVET__FILE_SYSTEM__PATH=/var/lib/rivet-engine
ENTRYPOINT ["/sbin/tini", "--", "/usr/bin/rivet-engine"]
CMD ["start", "--config", "/etc/rivet/config.json"]
