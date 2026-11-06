# postq — Rust 서버(postq-server) 하나가 API 와 화면을 함께 낸다. 실행 이미지에 Node 는 없다.
# 화면은 전부 클라이언트 컴포넌트라 정적 내보내기(out/)를 Rust 가 그대로 내준다.

# 1) 화면 — Next 정적 내보내기. Node 는 빌드에만 쓴다.
FROM node:22-alpine AS ui
WORKDIR /app
COPY package*.json ./
# 플랫폼별 사전 빌드 패키지를 사용한다. 설치 스크립트 없이도 정적 화면을 빌드할 수 있다.
RUN npm ci --ignore-scripts
COPY . .
RUN npm run build

# 2) 서버 — musl 정적 실행 파일. rusqlite(bundled)·ring 이 C 컴파일러를 쓴다.
FROM rust:1-alpine AS server
WORKDIR /src
RUN apk add --no-cache musl-dev
COPY server/Cargo.toml server/Cargo.lock ./
COPY server/src ./src
RUN cargo build --release --locked --bin postq-server

# 3) 실행 — 실행 파일 + 화면 + 마이그레이션.
FROM alpine:3.20
WORKDIR /app
# 컨테이너 안에서는 모든 인터페이스에 연다 — 기본 127.0.0.1 이면 포트 매핑이 닿지 않는다.
ENV DB_PATH=/data/postq.db \
    PORT=3000 \
    POSTQ_HOST=0.0.0.0 \
    POSTQ_STATIC_DIR=/app/ui \
    MIGRATIONS_DIR=/app/drizzle
COPY --from=server /src/target/release/postq-server /usr/local/bin/postq-server
COPY --from=ui /app/out ./ui
COPY --from=ui /app/drizzle ./drizzle
# 비루트 실행(uid 1000). /data 는 기동 시 소유권이 맞아야 한다.
RUN addgroup -g 1000 app && adduser -D -u 1000 -G app app && mkdir -p /data && chown -R app:app /data /app
USER app
VOLUME /data
EXPOSE 3000
# wget 은 alpine 의 busybox 것.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:3000/api/health || exit 1
CMD ["postq-server"]
