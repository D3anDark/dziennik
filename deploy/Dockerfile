# Builds the frontend and the server, and ships both in a small image. Used by install.sh through compose.yaml.
FROM node:22-bookworm-slim AS web
WORKDIR /src/web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

FROM rust:1-bookworm AS server
WORKDIR /src
# The whole tree with its .git: build.rs compares it with the official repository (see /api/about).
COPY . .
# The cache mounts keep downloaded crates and compiled dependencies between builds, so an update compiles only what
# changed. They are not part of the image: the binary is copied out in the same step.
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/src/target \
    cargo build --release --locked && cp target/release/dziennik /usr/local/bin/dziennik

FROM debian:bookworm-slim
# The server verifies Librus and the push services against the system's certificate store.
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/* \
    && useradd --system --home-dir /data dziennik && install -d -o dziennik /data
COPY --from=server /usr/local/bin/dziennik /usr/local/bin/dziennik
COPY --from=web /src/web/dist /srv/web
ENV DB=/data/dziennik.db WEB_DIR=/srv/web BIND=0.0.0.0:8080
USER dziennik
VOLUME /data
EXPOSE 8080
CMD ["dziennik"]
