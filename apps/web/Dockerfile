FROM node:24-slim AS base
WORKDIR /repo
RUN corepack enable

FROM base AS deps
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml* ./
COPY packages ./packages
COPY apps/web/package.json ./apps/web/package.json
COPY apps/server/package.json ./apps/server/package.json
RUN pnpm install --frozen-lockfile

FROM deps AS build
COPY . .
RUN pnpm exec tsc -b && pnpm --filter @seatgrab/web build:online

FROM nginx:1.27-alpine AS runtime
COPY --from=build /repo/apps/web/dist /usr/share/nginx/html
# The build emits hidden source maps, which carry the full application source. They exist
# for `scripts/check_build_privacy.mjs` to read and are not part of the site, so delete
# them from the image: an image that has no map cannot serve one.
RUN find /usr/share/nginx/html -name '*.map' -exec rm -f {} + \
 && ! find /usr/share/nginx/html -name '*.map' | grep -q .
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
