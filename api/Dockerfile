FROM golang:1.24-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /out/nodi-api ./cmd/server

FROM alpine:3.22
RUN apk add --no-cache ca-certificates \
    && addgroup -S nodi \
    && adduser -S -G nodi -h /app nodi \
    && mkdir -p /data/uploads \
    && chown -R nodi:nodi /data
COPY --from=build /out/nodi-api /usr/local/bin/nodi-api
USER nodi
WORKDIR /app
ENV PORT=8787 UPLOAD_DIR=/data/uploads
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -q -O - http://127.0.0.1:8787/health >/dev/null || exit 1
ENTRYPOINT ["/usr/local/bin/nodi-api"]
