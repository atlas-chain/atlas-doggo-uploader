# Atlas doggo uploader — production container.
# Runs the Bun upload engine with the live dashboard on :3000. Mount the PNG
# directory at /data and pass ATLAS_PRIVATE_KEY; the wallet self-funds from
# the public faucet, and the dashboard lingers after the run (default 60 min).
#
#   docker run -p 3000:3000 -e ATLAS_PRIVATE_KEY=0x… \
#     -v /path/to/pngs:/data:ro -v $PWD/out:/app/out \
#     ghcr.io/atlas-chain/atlas-doggo-uploader:latest

FROM oven/bun:1-alpine

WORKDIR /app
ENV NODE_ENV=production PORT=3000

# runtime deps only, from the committed lockfile
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# app code (no .env, no dataset — see .dockerignore)
COPY src ./src
COPY scripts ./scripts

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD bun -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["bun", "scripts/upload-dir.mjs", "--dir", "/data"]
