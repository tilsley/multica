# syntax=docker/dockerfile:1.7
#
# bb: a celld node with the bb Worker project baked in.
#   docker build -t bb ./bb
#   docker build -t bb-gateway --target gateway ./bb   (the sandbox gateway)
# The same image runs every node of the fleet; pod 0 (BB_DEPLOY=1) publishes the
# deployment to the fleet bucket before it starts serving.

ARG BUN_IMAGE=oven/bun:1.4.4
ARG RUNTIME_IMAGE=debian:bookworm-slim
ARG CELLD_VERSION=v0.6.2

# --- celld, pinned by checksum per architecture ------------------------------
FROM scratch AS celld-amd64
ADD --checksum=sha256:ce0ee3552cc8d55dde3998dc3b1b0c8f547bbcb4bc803d2a94842368b047646c \
    https://github.com/denoland/celld/releases/download/v0.6.2/celld-x86_64-unknown-linux-gnu.gz /celld.gz
FROM scratch AS celld-arm64
ADD --checksum=sha256:4eca87c6797590000a344c1b768364e9696e8817f5fbc16193f459d2edac7cd0 \
    https://github.com/denoland/celld/releases/download/v0.6.2/celld-aarch64-unknown-linux-gnu.gz /celld.gz
# --- production dependencies -------------------------------------------------
# celld bundles the Worker itself at deploy (as `celld dev` does): its bundler
# serves Node built-ins and CommonJS the way celld's runtime expects, which a
# pre-built bundle cannot match (celld has no node:module.createRequire).
FROM ${BUN_IMAGE} AS deps
WORKDIR /src
COPY package.json bun.lock ./
RUN --mount=type=secret,id=extra_ca,required=false \
    if [ -s /run/secrets/extra_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/extra_ca; fi; \
    bun install --production --frozen-lockfile --ignore-scripts

# --- gateway: the sandbox gateway (docker build --target gateway) -------------
# Clones repositories (git), packs and unpacks trees (tar) and talks to the
# Kubernetes API and sandboxes for the Worker. Same sources and dependencies.
FROM ${BUN_IMAGE} AS gateway
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates tar \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /var/lib/bb-gateway && chown bun:bun /var/lib/bb-gateway
WORKDIR /app
COPY --from=deps --chown=bun:bun /src/node_modules /app/node_modules
COPY --chown=bun:bun package.json tsconfig.json /app/
COPY --chown=bun:bun src /app/src
USER bun
ENV BB_GATEWAY_DIR=/var/lib/bb-gateway
EXPOSE 8090
ENTRYPOINT ["bun", "src/gateway/main.ts"]

# --- runtime (default target): a celld node --------------------------------
FROM ${RUNTIME_IMAGE}
# Both pinned binaries come in; the target architecture's is kept. (A stage named
# by ${TARGETARCH} would be neater, but skaffold's Dockerfile parser rejects it.)
COPY --from=celld-amd64 /celld.gz /tmp/celld-amd64.gz
COPY --from=celld-arm64 /celld.gz /tmp/celld-arm64.gz
ARG TARGETARCH
RUN gzip -dc "/tmp/celld-${TARGETARCH:-amd64}.gz" > /usr/local/bin/celld && chmod 755 /usr/local/bin/celld && rm /tmp/celld-*.gz \
 && useradd --system --create-home --home-dir /var/lib/bb bb \
 && mkdir -p /app && chown bb:bb /app
# /app is the celld project: sources + production deps; the entrypoint writes
# wrangler.json and `celld deploy` bundles it.
COPY --from=deps --chown=bb:bb /src/node_modules /app/node_modules
COPY --chown=bb:bb package.json tsconfig.json /app/
COPY --chown=bb:bb src /app/src
COPY docker/entrypoint.sh /usr/local/bin/bb-entrypoint
USER bb
WORKDIR /app
EXPOSE 8080 8081
ENTRYPOINT ["/usr/local/bin/bb-entrypoint"]
