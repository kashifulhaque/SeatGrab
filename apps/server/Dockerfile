FROM node:24-slim AS base
WORKDIR /repo
RUN corepack enable

FROM base AS deps
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml* ./
COPY packages ./packages
COPY apps/server/package.json ./apps/server/package.json
COPY apps/web/package.json ./apps/web/package.json
RUN pnpm install --frozen-lockfile

FROM deps AS build
COPY . .
RUN pnpm exec tsc -b

FROM node:24-slim AS runtime
WORKDIR /repo
RUN corepack enable
ENV NODE_ENV=production
COPY --from=build /repo /repo
EXPOSE 8787
CMD ["node", "apps/server/dist/index.js"]
