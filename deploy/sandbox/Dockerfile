# syntax=docker/dockerfile:1.7
#
# The sandbox bb's agent works in: agent-sandbox's sandboxd (files over REST on
# :8080, commands over gRPC on :9090, rooted at /workspace) on Debian with the
# tools a coding agent reaches for. Claimed from a warm pool (deploy/k8s/sandbox.yaml).
#
# sandboxd has no released image yet, only the project's staging builds; pin a
# digest here once there is a release.
ARG SANDBOXD_IMAGE=us-central1-docker.pkg.dev/k8s-staging-images/agent-sandbox/sandboxd:latest-main
ARG BASE_IMAGE=debian:bookworm-slim

FROM ${SANDBOXD_IMAGE} AS sandboxd

FROM ${BASE_IMAGE}
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates procps git curl jq ripgrep make patch unzip xz-utils less file \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --uid 1000 --create-home --home-dir /home/agent agent \
 && mkdir -p /workspace && chown 1000:1000 /workspace
COPY --from=sandboxd /usr/local/bin/sandboxd /usr/local/bin/sandboxd
WORKDIR /workspace
USER 1000
ENV HOME=/home/agent
EXPOSE 8080 9090
ENTRYPOINT ["/usr/local/bin/sandboxd"]
