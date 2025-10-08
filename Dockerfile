# ---------- Build stage ----------
FROM node:22-alpine AS build
WORKDIR /app

# Toolchain for native deps during build
RUN apk add --no-cache python3 make g++

# Install deps (including dev) and build
COPY package*.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --include=dev

COPY tsconfig.json ./
COPY src ./src
# Build your TS entrypoint
RUN npx tsup src/run_realtime.ts --format esm --dts

# Remove dev deps so node_modules only has production packages
RUN npm prune --omit=dev && npm cache clean --force

# ---------- Runtime stage ----------
FROM node:22-alpine
WORKDIR /app

ENV NODE_ENV=production \
    DB_PATH=/data/events.db
# Optional: timezone for logs
# ENV TZ=Asia/Jerusalem

# Create non-root user
RUN adduser -D -u 10001 appuser

# Copy prod node_modules and built app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package*.json ./
COPY --from=build /app/dist ./dist

# Drop privileges after files are in place
USER 10001

CMD ["node", "dist/run_realtime.js"]
