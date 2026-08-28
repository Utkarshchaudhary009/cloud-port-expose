FROM node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32
WORKDIR /app

# `node:22-alpine` ships a `node` user (uid 1000). We use it for parity with
# the agent image's non-root posture and to keep container scans quiet.
# /app must be owned by `node` so the dev server can write its build cache.
COPY --chown=node:node package.json package-lock.json ./
RUN npm ci --no-audit --no-fund \
    && chown -R node:node /app
COPY --chown=node:node pages ./pages

USER node

# Bind loopback only — the sidecar agent shares this netns and dials 127.0.0.1.
CMD ["npm", "run", "dev"]
