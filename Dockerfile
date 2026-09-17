# ---- Stage 1: build the riso-layout binary from the riso-utils repo ----
# riso-utils (github.com/imeckler/riso-utils) is private, so this stage clones
# it with a read-only token passed as a build arg. Nothing is vendored.
#   locally:        docker build --build-arg RISO_UTILS_GITHUB_TOKEN="$(gh auth token)" .
#   DigitalOcean:   RISO_UTILS_GITHUB_TOKEN env var with scope BUILD_TIME (becomes --build-arg)
# Pin a new riso-utils commit with scripts/bump-riso-utils.sh.
# The token only exists in this throwaway stage; the app image gets the binary.
FROM rust:1.88-alpine AS riso
RUN apk add --no-cache musl-dev git
ARG RISO_UTILS_REV=3e0b56ff104777ee2e31e83c91f36a76059fdb68
ARG RISO_UTILS_GITHUB_TOKEN
WORKDIR /riso
RUN test -n "$RISO_UTILS_GITHUB_TOKEN" \
    || { echo "RISO_UTILS_GITHUB_TOKEN build arg is required to clone riso-utils" >&2; exit 1; } \
    && git init -q \
    && GIT_TERMINAL_PROMPT=0 git fetch -q --depth 1 \
         "https://x-access-token:${RISO_UTILS_GITHUB_TOKEN}@github.com/imeckler/riso-utils.git" \
         "$RISO_UTILS_REV" \
    && git checkout -q FETCH_HEAD \
    && rm -rf .git
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/riso/target \
    cargo build --release --locked --bin riso-layout \
    && cp target/release/riso-layout /usr/local/bin/riso-layout

# ---- Stage 2: the app ----
FROM node:18-alpine

# Install necessary packages for building native modules and Puppeteer dependencies
RUN apk add --no-cache python3 make g++ chromium

# Set up Puppeteer to use system Chromium
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV CHROMIUM_PATH=/usr/bin/chromium-browser

WORKDIR /app

# Copy package files first for better layer caching
COPY package*.json ./
COPY tsconfig.json ./

# Install dependencies with cache mount (speeds up rebuilds significantly)
RUN --mount=type=cache,target=/root/.npm \
    npm ci --prefer-offline --no-audit

# Copy source code
COPY src/ ./src/
COPY views/ ./views/
COPY public/ ./public/
COPY drizzle/ ./drizzle/
COPY build-client.js ./

# Create build directory and build the application
RUN npm run build

# Colour separation + sheet layout tool used by /layout
COPY --from=riso /usr/local/bin/riso-layout /usr/local/bin/riso-layout
ENV RISO_LAYOUT_BIN=/usr/local/bin/riso-layout

# Expose the port the app runs on
EXPOSE 3000

# Create non-root user for security
RUN addgroup -g 1001 -S nodejs
RUN adduser -S appuser -u 1001
USER appuser

# Start the application
CMD ["node", "build/index.js"]