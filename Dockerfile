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

# Install dependencies
RUN npm ci

# Copy source code
COPY src/ ./src/
COPY views/ ./views/
COPY public/ ./public/
COPY drizzle/ ./drizzle/
COPY build-client.js ./

# Create build directory and build the application
RUN npm run build

# Expose the port the app runs on
EXPOSE 3000

# Create non-root user for security
RUN addgroup -g 1001 -S nodejs
RUN adduser -S appuser -u 1001
USER appuser

# Start the application
CMD ["node", "build/index.js"]