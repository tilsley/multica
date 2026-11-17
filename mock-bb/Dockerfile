# syntax=docker/dockerfile:1.7
ARG GO_IMAGE=golang:1.26.9-alpine
FROM ${GO_IMAGE} AS build
WORKDIR /src
COPY go.mod ./
COPY *.go ./
RUN CGO_ENABLED=0 go build -trimpath -ldflags "-s -w" -o /out/mock-bb .

FROM alpine:3.21
RUN adduser -D mockbb
COPY --from=build /out/mock-bb /usr/local/bin/mock-bb
USER mockbb
EXPOSE 8787
HEALTHCHECK --interval=5s --timeout=3s CMD wget -qO- http://127.0.0.1:8787/health >/dev/null || exit 1
ENTRYPOINT ["/usr/local/bin/mock-bb"]
