# syntax=docker/dockerfile:1

# --- build: full dependencies, Prisma client generation and TypeScript compilation.
# This stage also carries the Prisma CLI, so it is the image used to run migrations.
FROM node:24.22.3-bookworm-slim AS build
# The Prisma CLI needs OpenSSL to talk to the database when it applies migrations.
RUN apt-get update && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY prisma.config.ts tsconfig.json tsconfig.build.json ./
COPY prisma ./prisma
COPY src ./src
# `prisma generate` reads the schema only; this URL is a placeholder and is never contacted.
RUN DATABASE_URL=postgresql://build:build@localhost:5432/build npm run build

# --- prod-deps: production dependencies only. @prisma/client declares the Prisma CLI and
# TypeScript as optional peers, and npm keeps them unless optional and peer packages are
# omitted too. The runtime needs neither, and leaving them in multiplies the image size.
FROM node:24.22.3-bookworm-slim AS prod-deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --omit=optional --omit=peer && npm cache clean --force
# The Prisma runtime ships a query compiler for every database it supports. Keep PostgreSQL only.
RUN cd node_modules/@prisma/client/runtime \
  && rm -f query_compiler_*.sqlserver.* query_compiler_*.cockroachdb.* \
       query_compiler_*.mysql.* query_compiler_*.sqlite.* *.map

# --- runtime: no shell, no package manager, non-root user.
FROM gcr.io/distroless/nodejs24-debian12:nonroot AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
USER nonroot
EXPOSE 3000
CMD ["dist/server.js"]
