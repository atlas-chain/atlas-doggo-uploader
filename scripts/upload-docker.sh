#!/usr/bin/env bash
# Start a new, isolated upload job in a docker container: fresh wallet, its
# own alias (--app), its own checkpoint/failure files under out/<alias>.
#
# Usage:
#   scripts/upload-docker.sh <alias> <host-dir-of-pngs> [extra upload-dir.mjs args...]
#
# Example:
#   scripts/upload-docker.sh cats ./cats-batch-3 --batch 20 --expires-days 14
#
# The container writes its checkpoint/log/failures to out/<alias>/ on the
# host (bind-mounted), so `docker logs -f upload-<alias>` and re-running this
# script after a crash both work as expected (restarts are duplicate-proof —
# see upload-dir.mjs's on-chain reconciliation).

set -euo pipefail

ALIAS="${1:?usage: upload-docker.sh <alias> <host-dir> [extra upload-dir.mjs args...]}"
HOST_DIR="${2:?usage: upload-docker.sh <alias> <host-dir> [extra upload-dir.mjs args...]}"
shift 2 || true
EXTRA_ARGS=("$@")

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE="atlas-apps:upload"
CONTAINER="upload-${ALIAS}"
HOST_DIR="$(cd "$HOST_DIR" && pwd)"
OUT_DIR="${ROOT}/out/${ALIAS}"

mkdir -p "$OUT_DIR"

echo "building image ${IMAGE}..."
docker build -t "$IMAGE" "$ROOT"

echo "generating fresh throwaway wallet for alias '${ALIAS}'..."
WALLET_JSON="$(docker run --rm "$IMAGE" node -e '
  import("@atlas-chain/sdk/accounts").then(({ generatePrivateKey, privateKeyToAccount }) => {
    const privateKey = generatePrivateKey()
    const { address } = privateKeyToAccount(privateKey)
    console.log(JSON.stringify({ privateKey, address }))
  })
')"
PRIVATE_KEY="$(node -e "console.log(JSON.parse(process.argv[1]).privateKey)" "$WALLET_JSON")"
ADDRESS="$(node -e "console.log(JSON.parse(process.argv[1]).address)" "$WALLET_JSON")"
echo "  address: ${ADDRESS}"

if docker ps -a --format '{{.Names}}' | grep -qx "$CONTAINER"; then
  echo "removing stale container ${CONTAINER}..."
  docker rm -f "$CONTAINER" >/dev/null
fi

echo "starting container ${CONTAINER}..."
docker run -d \
  --name "$CONTAINER" \
  -e ATLAS_PRIVATE_KEY="$PRIVATE_KEY" \
  -e ATLAS_PAYLOAD_BEARER_KEY=atlas-signer-pub-token \
  -v "${HOST_DIR}:/data:ro" \
  -v "${OUT_DIR}:/app/out" \
  "$IMAGE" \
  node scripts/upload-dir.mjs --dir /data --app "$ALIAS" "${EXTRA_ARGS[@]}"

echo "started: docker logs -f ${CONTAINER}"
echo "owner (wallet) for the viewer: OWNER=${ADDRESS} npm run viewer -- --port 8799"
