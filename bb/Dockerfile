# syntax=docker/dockerfile:1.7
#
# bb: a celld node with the bb Worker deployment baked in.
#   docker build -t bb ./bb
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
# --- bundle the Worker once, so nodes need no esbuild -------------------------
FROM ${BUN_IMAGE} AS bundle
WORKDIR /src
COPY package.json bun.lock ./
RUN --mount=type=secret,id=extra_ca,required=false \
    if [ -s /run/secrets/extra_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/extra_ca; fi; \
    bun install --frozen-lockfile --ignore-scripts
COPY tsconfig.json ./
COPY src ./src
RUN ./node_modules/.bin/esbuild src/worker/index.ts --bundle --format=esm --platform=neutral \
      --main-fields=module,main --conditions=workerd,worker,import --external:cloudflare:workers \
      --external:'node:*' --outfile=dist/worker.js

# --- runtime ----------------------------------------------------------------
FROM ${RUNTIME_IMAGE}
# Both pinned binaries come in; the target architecture's is kept. (A stage named
# by ${TARGETARCH} would be neater, but skaffold's Dockerfile parser rejects it.)
COPY --from=celld-amd64 /celld.gz /tmp/celld-amd64.gz
COPY --from=celld-arm64 /celld.gz /tmp/celld-arm64.gz
ARG TARGETARCH
RUN gzip -dc "/tmp/celld-${TARGETARCH:-amd64}.gz" > /usr/local/bin/celld && chmod 755 /usr/local/bin/celld && rm /tmp/celld-*.gz \
 && useradd --system --create-home --home-dir /var/lib/bb bb \
 && mkdir -p /app && chown bb:bb /app
# /app is the celld project: the entrypoint writes wrangler.json beside the bundle.
COPY --from=bundle --chown=bb:bb /src/dist/worker.js /app/dist/worker.js
COPY docker/entrypoint.sh /usr/local/bin/bb-entrypoint
USER bb
WORKDIR /app
EXPOSE 8080 8081
ENTRYPOINT ["/usr/local/bin/bb-entrypoint"]
