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

ENV NODE_ENV=production
EXPOSE 32411

CMD ["node", "server.js"]
