# atlas-doggo-uploader 🐶

Bun-powered batch uploader for the [Atlas](https://scanner.atlas.arkiv-global.net) (experimental Arkiv) data network, with a **real-time dashboard** that shows every stage of the commitment pipeline while ~75k dog pictures march onto the chain.

![live dashboard](docs/dashboard.png)

## What it does

- **Batched uploads** — N images per on-chain transaction: payloads go to the payload provider in parallel, then one `execute()` commits the batch to the EntityRegistry.
- **Live commitment pipeline** — the dashboard tracks each batch through its three stages: ① payload upload → ② send to blockchain → ③ receive receipt, with per-file status dots and stage timings.
- **Real-time stats** — throughput (MB/s, files/min), batch commit latency (stacked payload / tx submit / receipt wait), latency percentiles, wallet balance with faucet-drip markers, gas & fees, RPC health, recent files with scanner links, an event log, and a strip of freshly uploaded doggos served back from the payload provider.
- **Self-sustaining** — auto-tops-up from the public faucet (proof-of-work solved across all cores) when the balance runs low.
- **Duplicate-proof restarts** — a local checkpoint plus on-chain reconciliation (paginated `arkiv_query` by owner+app) means re-runs and fresh servers never re-upload.
- **Lingering dashboard** — after the run finishes the dashboard stays up (default **60 min**, `--linger-min`), shows the final summary and a countdown, and can be extended from the page; then the process exits on its own.

## Quickstart

```bash
bun install
bun run new-wallet          # writes a throwaway key to .env
bun scripts/upload-dir.mjs --dir /path/to/pngs --app my-dogs --batch 10
# dashboard → http://localhost:3000
```

The wallet funds itself from the faucet on first need. Stop any time with Ctrl-C (finishes the current batch) or the dashboard's *stop after batch* button.

### CLI options

```
--dir <path>          directory of PNGs (default: the ../Images/Dogs dataset)
--batch <n>           images per transaction, 1-50            (default 10)
--app <name>          "app" attribute used for grouping       (default dogs)
--run <id>            "run" attribute                         (default: app)
--limit <n>           upload at most n files this run
--expires-days <n>    entity TTL in days                      (default 30)
--min-balance <glm>   faucet refill threshold                 (default 0.3)
--no-autofund         never claim from the faucet
--no-reconcile        skip the on-chain duplicate check
--port <n>            dashboard port                          (default $PORT or 3000)
--linger-min <n>      keep the dashboard up n minutes after the run (default 60)
--no-dashboard        headless: no web dashboard
```

### Dashboard API

| endpoint | method | purpose |
| --- | --- | --- |
| `/` | GET | the dashboard |
| `/ws` | WS | full state snapshot on connect, then live deltas |
| `/api/state` | GET | current state as JSON |
| `/api/linger?min=60` | POST | reset the shutdown countdown to n minutes from now |
| `/api/stop` | POST | finish the current batch, then stop uploading |
| `/healthz` | GET | container healthcheck |

## Docker

Published to GHCR on every push/tag:

```bash
docker run -p 3000:3000 \
  -e ATLAS_PRIVATE_KEY=0x… \
  -v /path/to/pngs:/data:ro \
  -v "$PWD/out:/app/out" \
  ghcr.io/atlas-chain/atlas-doggo-uploader:latest
```

Or let `scripts/upload-docker.sh <alias> <dir>` build the image, generate a fresh wallet and start an isolated, named job with its own checkpoint and dashboard port (`PORT=3001 scripts/upload-docker.sh cats ./cats`).

## Repo layout

```
src/uploader/    engine (batching, checkpoint, reconcile, faucet), event-bus
                 instrumentation (payload fetch + RPC transport observers), stats
src/dashboard/   Bun.serve server (static + WebSocket) and the dashboard UI
src/lib/         Atlas endpoints/clients, faucet PoW client, raw read helpers
scripts/         upload-dir (main CLI), viewer, bench, fund, hello, probe-net
tests/           bun test — offline by default, ATLAS_E2E=1 for the live round-trip
```

Other apps that share the libs: `bun run viewer` (on-chain image gallery), `bun run bench` (multi-wallet load test), `bun run hello` (round-trip smoke).

## Development

```bash
bun test tests/            # offline tests
ATLAS_E2E=1 bun test tests/ # + live upload/download round-trip
```

Testnet only: keys are throwaways, GLM comes from the public faucet, and everything uploaded expires with its TTL.
