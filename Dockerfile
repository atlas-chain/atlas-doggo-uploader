# Atlas image viewer — production container.
# Reads image metadata from Atlas (public RPC) and streams bytes from the public
# payload provider, so the container needs NO private key / secrets / dataset.

FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production PORT=3000 APP=atlas-loadtest

# install only runtime deps (uses the committed lockfile)
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# app code: the viewer + the shared read library (no .env, no dataset — see .dockerignore)
COPY src ./src
COPY scripts ./scripts

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "scripts/viewer-server.mjs"]
