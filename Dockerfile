# Railway builds with this instead of Railpack whenever a Dockerfile sits at the
# repo root, and that is the whole reason this file exists.
#
# The service's Railpack build command ran `npm ci --omit=dev` AFTER railpack had
# already done its own `npm install`, and died with
#
#   EBUSY: resource busy or locked, rmdir '/app/node_modules/.vite'
#
# `npm ci` removes node_modules wholesale before installing, and railpack mounts
# build caches inside node_modules — a mount point cannot be rmdir'd, so that
# command could never succeed there, on any retry. In a clean image stage there
# is no such mount and the very same command is simply correct.
#
# This builds the API only. The frontend is served by Vercel, and server/app.js
# mounts its static handlers only when dist/ is present (`hasClient`), so
# leaving the Vite build out gives a pure-API process rather than a broken one —
# the same shape `npm run server` and the test suite already run in.
#
# Nothing else reads this file: Vercel builds from vercel.json, and render.yaml
# pins `runtime: node`, so neither platform uses a Dockerfile.

FROM node:24-slim AS deps
WORKDIR /app
# Only the manifests, so this layer is reused whenever dependencies are
# unchanged. devDependencies are test-only here (mongodb-memory-server,
# supertest, vitest) and nothing at runtime imports them.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:24-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node . .
# The process writes nothing to disk — images go to Cloudinary and state to
# Mongo — so it has no reason to run as root.
USER node
# Documentation only. config/env.js reads PORT and falls back to 5000; the
# platform injects the real one and app.listen binds whatever it is given.
EXPOSE 5000
CMD ["node", "server/index.js"]
