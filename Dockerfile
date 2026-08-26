# syntax=docker/dockerfile:1
# Multi-stage: build the static Astro site, serve dist/ with nginx.
# Coolify must use build_pack=dockerfile — nixpacks has no start command
# for static sites and crash-loops (503).
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci || npm install
COPY . .
# PUBLIC_* vars are inlined into the bundle at build time. The composer
# wires one ARG/ENV pair per feature right below this anchor; the deploy
# skill supplies the values as Coolify build args.
# brotea:build-args
ARG PUBLIC_SUPABASE_ANON_KEY
ENV PUBLIC_SUPABASE_ANON_KEY=$PUBLIC_SUPABASE_ANON_KEY
ARG PUBLIC_SUPABASE_URL
ENV PUBLIC_SUPABASE_URL=$PUBLIC_SUPABASE_URL
ARG PUBLIC_PB_URL
ENV PUBLIC_PB_URL=$PUBLIC_PB_URL
ARG PUBLIC_BUILD_COMMIT
ENV PUBLIC_BUILD_COMMIT=$PUBLIC_BUILD_COMMIT
RUN npm run build
# Bricks that must PROVE something about the built artifact wire their check
# below this anchor. The form incident of 2026-07-29 is why: a landing shipped
# with no endpoint in its HTML, the build was green, and the form was dead for
# days. A warning would have been ignored; a failing build cannot be.
# brotea:post-build

FROM nginx:alpine
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
