// Network probe: measure the REAL payload-upload throughput from this host to
// the Atlas payload provider — the phase that dominates per-tx time. Uploads
// unique (incompressible) PNGs so the provider can't dedup them, at a chosen
// concurrency, and reports aggregate MB/s. Run with different --concurrency (and
// ATLAS_HTTP_CONNECTIONS) to tell "serialized uploads" from "capped bandwidth".
//
// Usage: node scripts/probe-net.mjs [--count 50] [--concurrency 50] [--size 95000]

import { parseArgs } from "node:util"
import { randomBytes } from "node:crypto"
import { PayloadProviderClient } from "@atlas-chain/sdk/payloadProvider"
import { PAYLOAD_URL, NAMESPACE, getBearerKey, pooledFetch } from "../src/lib/atlas.js"
import { makePngOfApproxSize } from "../src/lib/png.js"

const { values } = parseArgs({
  options: {
    count: { type: "string", default: "50" },
    concurrency: { type: "string", default: "50" },
    size: { type: "string", default: "95000" },
  },
})
const COUNT = Math.max(1, Number(values.count))
const CONC = Math.max(1, Number(values.concurrency))
const SIZE = Number(values.size)
const hex32 = () => `0x${randomBytes(32).toString("hex")}`

const provider = new PayloadProviderClient({
  url: PAYLOAD_URL,
  bearerKey: getBearerKey(),
  ...(pooledFetch && { fetch: pooledFetch }),
})

console.log(`payload-upload probe`)
console.log(`  count=${COUNT} concurrency=${CONC} size≈${SIZE}B  pooledFetch=${!!pooledFetch} (ATLAS_HTTP_CONNECTIONS=${process.env.ATLAS_HTTP_CONNECTIONS ?? "128"})`)

// pre-generate unique, incompressible payloads (so the provider can't dedup)
const base = Number(randomBytes(3).readUIntBE(0, 3))
const payloads = Array.from({ length: COUNT }, (_, i) => makePngOfApproxSize(SIZE, base + i))
const totalBytes = payloads.reduce((s, p) => s + p.length, 0)

async function uploadOne(payload, i) {
  const t = Date.now()
  const res = await provider.submitArkivPayload({
    namespace: NAMESPACE,
    payload,
    contentType: "image/png",
    attributes: [],
    expiresIn: 86400,
    entityKey: hex32(),
    nonce: hex32(),
    payment: 100000,
  })
  return { ms: Date.now() - t, created: res.created }
}

// bounded-concurrency pool
async function run() {
  const results = []
  let next = 0
  const t0 = Date.now()
  await Promise.all(
    Array.from({ length: Math.min(CONC, COUNT) }, async () => {
      while (next < COUNT) {
        const i = next++
        try {
          results.push(await uploadOne(payloads[i], i))
        } catch (e) {
          results.push({ ms: 0, error: e.message })
        }
      }
    }),
  )
  const elapsed = (Date.now() - t0) / 1000
  const ok = results.filter((r) => !r.error)
  const lat = ok.map((r) => r.ms).sort((a, b) => a - b)
  console.log(`\nuploaded ${ok.length}/${COUNT}  (${results.length - ok.length} failed, ${ok.filter((r) => !r.created).length} deduped)`)
  console.log(`elapsed   : ${elapsed.toFixed(2)} s`)
  console.log(`throughput: ${(totalBytes / 1e6 / elapsed).toFixed(2)} MB/s   ${(ok.length / elapsed).toFixed(1)} uploads/s`)
  console.log(`per-upload: p50 ${lat[(lat.length / 2) | 0] ?? 0}ms  max ${lat[lat.length - 1] ?? 0}ms`)
  const sample = results.find((r) => r.error)
  if (sample) console.log(`error     : ${sample.error}`)
}

run().catch((e) => {
  console.error("probe failed:", e)
  process.exit(1)
})
