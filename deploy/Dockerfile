# Stage 1: Build (native modules need build tools)
FROM node:24-slim AS builder
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*
WORKDIR /build
COPY app/package.json app/package-lock.json ./
RUN npm ci --omit=dev

# Stage 2: Runtime
FROM node:24-slim
WORKDIR /app
COPY --from=builder /build/node_modules ./node_modules
COPY app/ .

# Create DB directory and set ownership before switching to non-root.
# The node user (uid 1000) is provided by the node base image.
# For named Docker volumes, ownership is set on first mount from the
# container's directory state. Existing volumes retain their permissions —
# see deploy notes for the one-time fix command.
RUN mkdir -p /data/db && chown node:node /data/db

ENV NODE_ENV=production
EXPOSE 32411

USER node
CMD ["node", "server.js"]
