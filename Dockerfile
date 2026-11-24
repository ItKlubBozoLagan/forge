# One image for the whole application: the API process also serves the built web app.
#   docker build -t forge .

FROM node:22-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable && corepack prepare pnpm@9.10.0 --activate
WORKDIR /app
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY packages/core/package.json packages/core/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY apps/cli/package.json apps/cli/
COPY e2e/package.json e2e/

FROM base AS web
RUN pnpm install --frozen-lockfile --filter "@forge/web..."
COPY packages/core packages/core
COPY apps/web apps/web
RUN pnpm --filter @forge/web build

FROM base AS app
RUN pnpm install --frozen-lockfile --prod --filter "@forge/api..."
COPY packages/core packages/core
COPY apps/api apps/api
COPY --from=web /app/apps/web/dist apps/web/dist

LABEL org.opencontainers.image.source=https://github.com/ItKlubBozoLagan/forge

# The TypeScript loader keeps its cache under the temporary directory, so /tmp must be
# writable; everything else works on a read-only root filesystem.
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8080 WEB_DIST=/app/apps/web/dist HOME=/tmp
USER 1000:1000
WORKDIR /app/apps/api
EXPOSE 8080
CMD ["node", "--import", "tsx", "src/main.ts"]
