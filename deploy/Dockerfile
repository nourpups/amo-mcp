# syntax=docker/dockerfile:1.7

# --- Build stage: compile TS to JS ---
FROM node:20-alpine AS build
WORKDIR /app

# install build deps first to maximise cache hits
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# --- Runtime stage: only prod deps + dist ---
FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

# tini gives proper signal handling (Ctrl-C / docker stop)
RUN apk add --no-cache tini

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist

# Run as non-root (the official node image ships a "node" user)
USER node

EXPOSE 8765

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/index.js"]
