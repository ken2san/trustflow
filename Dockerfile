# Build stage.
#
# Node 22 because package.json requires >=22.18 and CI runs 22. It was node:18
# until Task 17, which could not have built this project: the unit suite imports
# a TypeScript module from supabase/functions/_shared directly, which needs the
# newer loader, and npm would have warned about the engines range and carried on.
# A Dockerfile that cannot build what it claims to build is worse than none,
# because it looks like a working fallback.
FROM node:22-alpine AS build
WORKDIR /app

# ci, not install: it installs exactly what package-lock.json records, which is
# the point of having a lockfile in an image build. --legacy-peer-deps was
# dropped with it; nothing in this tree needs it.
COPY package.json package-lock.json ./
RUN npm ci

COPY . .

# Vite inlines VITE_* at BUILD time, so these have to be present here — and the
# failure when they are not is silent, which is why the build now refuses.
#
# Measured while fixing the Node version: an image built with no environment
# produced a 277 kB bundle instead of 461 kB, because `src/lib/supabase.js`
# reads `url && key ? createClient(url, key) : null` and Rollup folds that to
# `null` when both are statically empty — dropping @supabase/supabase-js
# entirely. The result is a frontend that looks completely normal and cannot
# reach the backend at all: every screen renders its unconfigured state.
# A build that cannot work should not produce an image.
#
# These are not secrets. The Supabase URL, the publishable anon key and the
# Turnstile site key are all served inside the bundle to every visitor; build
# args are the right place for them. Nothing here takes a service-role key, a
# database password or any .env file — the context excludes those outright
# (.dockerignore).
ARG VITE_SUPABASE_URL
ARG VITE_SUPABASE_ANON_KEY
ARG VITE_TURNSTILE_SITE_KEY
RUN if [ -z "$VITE_SUPABASE_URL" ] || [ -z "$VITE_SUPABASE_ANON_KEY" ]; then \
      echo "REFUSING TO BUILD: VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY must be"; \
      echo "passed as build args, or the bundle silently ships with no backend client."; \
      echo "  docker build --build-arg VITE_SUPABASE_URL --build-arg VITE_SUPABASE_ANON_KEY ."; \
      exit 1; \
    fi

RUN npm run build

# Serve stage.
FROM nginx:stable-alpine
COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx/default.conf /etc/nginx/conf.d/default.conf
EXPOSE 8080
CMD ["nginx", "-g", "daemon off;"]
