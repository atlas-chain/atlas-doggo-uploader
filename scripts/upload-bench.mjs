// Configurable load-test uploader for Atlas.
//
// Pushes real dog PNGs (~95KB) into Atlas and reports throughput + latency.
// Concurrency comes from (a) batching B images per transaction — payloads are
// uploaded to the provider in parallel, then committed in ONE on-chain tx — and
// (b) running A independent sender accounts as parallel tx streams.
//
// Usage:
//   node scripts/upload-bench.mjs [--accounts 3] [--batch 5] [--count 100]
//                                 [--duration 0] [--app atlas-loadtest]
//                                 [--run <id>] [--expires-days 7] [--random]
//
//   --count N      stop after N images (default 100); --duration S overrides with a time box
//   --random       pick images randomly from the dataset instead of sequentially

import { parseArgs } from "node:util"
import { readFileSync, writeFileSync, mkdirSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"
import { formatEther } from "@atlas-chain/sdk"
import { ExpirationTime } from "@atlas-chain/sdk/utils"
import { makeWalletClient } from "../src/lib/atlas.js"
import { listDogNames, dogPath } from "../src/lib/images.js"
import { loadOrCreatePool, ensureFunded } from "../src/lib/wallet-pool.js"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const now = () => Date.now()

const { values } = parseArgs({
  options: {
    accounts: { type: "string", default: "3" },
    batch: { type: "string", default: "5" },
    count: { type: "string", default: "100" },
    duration: { type: "string", default: "0" },
    app: { type: "string", default: "atlas-loadtest" },
    run: { type: "string" },
    "expires-days": { type: "string", default: "7" },
    random: { type: "boolean", default: false },
  },
})

const ACCOUNTS = Math.max(1, Number(values.accounts))
const BATCH = Math.max(1, Number(values.batch))
const COUNT = Math.max(1, Number(values.count))
const DURATION_MS = Number(values.duration) * 1000
const APP = values.app
const RUN_ID = values.run ?? `run-${new Date().toISOString().replace(/[:.]/g, "-")}`
const EXPIRES = ExpirationTime.fromDays(Number(values["expires-days"]))

const pct = (sorted, p) =>
  sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] : 0

async function main() {
  console.log(`Atlas upload benchmark`)
  console.log(
    `  accounts=${ACCOUNTS} batch=${BATCH} ${DURATION_MS ? `duration=${DURATION_MS / 1000}s` : `count=${COUNT}`} app=${APP} run=${RUN_ID}\n`,
  )

  // 1. dataset
  const names = listDogNames()
  if (!names.length) throw new Error("no dog images found")

  // 2. funded sender pool
  const pool = loadOrCreatePool(ACCOUNTS, join(ROOT, "out", "bench-accounts.json"))
  console.log("preparing sender accounts…")
  await ensureFunded(pool, { log: (m) => console.log("  " + m) })
  const balancesBefore = pool.map((a) => a.balance)
  console.log("")

  // 3. shared work queue (image indices)
  let cursor = 0
  const total = DURATION_MS ? Infinity : COUNT
  const deadline = DURATION_MS ? now() + DURATION_MS : Infinity
  const records = [] // { ms, batch, bytes, ok, err }
  let uploaded = 0
  let nextSeq = 0

  const nextBatch = () => {
    if (uploaded >= total || now() >= deadline) return null
    const items = []
    for (let i = 0; i < BATCH && uploaded + items.length < total; i++) {
      const idx = values.random ? (Math.random() * names.length) | 0 : cursor++ % names.length
      items.push({ name: names[idx], seq: nextSeq++ })
    }
    uploaded += items.length
    return items
  }

  // 4. one async loop per account = parallel tx streams
  const t0 = now()
  let lastLog = t0
  const worker = async (acct, ai) => {
    const client = makeWalletClient(acct.privateKey)
    for (;;) {
      const items = nextBatch()
      if (!items) break
      const creates = items.map(({ name, seq }) => {
        const bytes = new Uint8Array(readFileSync(dogPath(name)))
        return {
          payload: bytes,
          contentType: "image/png",
          // keys must be lowercase + sorted ascending: app < name < run < seq
          attributes: [
            { key: "app", value: APP },
            { key: "name", value: name },
            { key: "run", value: RUN_ID },
            { key: "seq", value: seq },
          ],
          expiresIn: EXPIRES,
          _bytes: bytes.length,
        }
      })
      const bytes = creates.reduce((s, c) => s + c._bytes, 0)
      for (const c of creates) delete c._bytes
      const started = now()
      let ok = false
      let err
      for (let attempt = 0; attempt < 2 && !ok; attempt++) {
        try {
          await client.mutateEntities({ creates })
          ok = true
        } catch (e) {
          err = e.message
        }
      }
      records.push({ acct: ai, startMs: started - t0, ms: now() - started, batch: creates.length, bytes, ok, err })
      if (now() - lastLog > 2000) {
        lastLog = now()
        const done = records.filter((r) => r.ok).reduce((s, r) => s + r.batch, 0)
        const secs = (now() - t0) / 1000
        process.stdout.write(`  ${done} images in ${secs.toFixed(1)}s = ${(done / secs).toFixed(1)} img/s\r`)
      }
    }
  }

  await Promise.all(pool.map(worker))
  const elapsed = (now() - t0) / 1000

  // 5. cost = balance delta across the pool
  let spent = 0n
  for (let i = 0; i < pool.length; i++) {
    const client = makeWalletClient(pool[i].privateKey)
    const after = await client.getBalance({ address: pool[i].address })
    spent += balancesBefore[i] - after
  }

  // 6. metrics
  const okRecs = records.filter((r) => r.ok)
  const failRecs = records.filter((r) => !r.ok)
  const okImages = okRecs.reduce((s, r) => s + r.batch, 0)
  const okBytes = okRecs.reduce((s, r) => s + r.bytes, 0)
  const lat = okRecs.map((r) => r.ms).sort((a, b) => a - b)
  const mean = lat.length ? Math.round(lat.reduce((s, x) => s + x, 0) / lat.length) : 0

  // per-second completion buckets (throughput-over-time)
  const buckets = new Array(Math.ceil(elapsed) || 1).fill(0)
  for (const r of okRecs) {
    const b = Math.min(buckets.length - 1, Math.floor((r.startMs + r.ms) / 1000))
    buckets[b] += r.batch
  }
  // per-account stats
  const perAccount = pool.map((a, i) => {
    const recs = okRecs.filter((r) => r.acct === i)
    return {
      address: a.address,
      txs: recs.length,
      images: recs.reduce((s, r) => s + r.batch, 0),
      failed: failRecs.filter((r) => r.acct === i).length,
    }
  })

  const metrics = {
    config: { accounts: ACCOUNTS, batch: BATCH, count: DURATION_MS ? null : COUNT, durationSec: DURATION_MS / 1000 || null, app: APP, run: RUN_ID, expiresDays: Number(values["expires-days"]) },
    summary: {
      elapsedSec: +elapsed.toFixed(2),
      images: okImages,
      txs: okRecs.length,
      failed: failRecs.length,
      imgPerSec: +(okImages / elapsed).toFixed(2),
      txPerSec: +(okRecs.length / elapsed).toFixed(2),
      mbPerSec: +(okBytes / 1e6 / elapsed).toFixed(2),
      totalBytes: okBytes,
      gasGlmTotal: formatEther(spent),
      gasGlmPerImage: okImages ? formatEther(spent / BigInt(okImages)) : "0",
    },
    txLatencyMs: { min: lat[0] ?? 0, p50: pct(lat, 50), p90: pct(lat, 90), p95: pct(lat, 95), p99: pct(lat, 99), max: lat[lat.length - 1] ?? 0, mean },
    throughputPerSec: buckets,
    perAccount,
    errors: [...new Set(failRecs.map((r) => r.err))].slice(0, 5),
    txRecords: records,
  }

  mkdirSync(join(ROOT, "out"), { recursive: true })
  const outFile = join(ROOT, "out", `bench-${RUN_ID}.json`)
  writeFileSync(outFile, JSON.stringify(metrics, null, 2))

  // 7. report
  console.log("\n\n── results ─────────────────────────────")
  console.log(`run id          : ${RUN_ID}`)
  console.log(`elapsed         : ${elapsed.toFixed(2)} s`)
  console.log(`images uploaded : ${okImages}  (${okRecs.length} txs, ${failRecs.length} failed)`)
  console.log(`throughput      : ${metrics.summary.imgPerSec} img/s   ${metrics.summary.txPerSec} tx/s   ${metrics.summary.mbPerSec} MB/s`)
  console.log(`tx latency (ms) : p50 ${pct(lat, 50)}  p90 ${pct(lat, 90)}  p95 ${pct(lat, 95)}  p99 ${pct(lat, 99)}  max ${lat[lat.length - 1] ?? 0}  mean ${mean}`)
  console.log(`cost            : ${metrics.summary.gasGlmTotal} GLM total  (~${metrics.summary.gasGlmPerImage} GLM/image)`)
  console.log(`per account     : ${perAccount.map((a) => a.images).join(" / ")} images`)
  if (failRecs.length) console.log(`errors (sample) : ${metrics.errors.join(" | ")}`)
  console.log(`metrics written : ${outFile}`)
  console.log(`view them       : node scripts/viewer-server.mjs --port 8799 --app ${APP}`)
}

main().catch((e) => {
  console.error("\nbenchmark failed:", e)
  process.exit(1)
})
