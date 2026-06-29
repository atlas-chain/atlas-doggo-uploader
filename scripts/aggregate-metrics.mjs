// Aggregate bench metrics JSON files (out/bench-*.json) into a comparison table.
// Usage: node scripts/aggregate-metrics.mjs [run-id-substring]

import { readdirSync, readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"

const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "out")
const filter = process.argv[2]

const files = readdirSync(OUT)
  .filter((f) => f.startsWith("bench-") && f.endsWith(".json"))
  .filter((f) => !filter || f.includes(filter))

if (!files.length) {
  console.error("no bench-*.json metrics found in out/")
  process.exit(1)
}

const rows = files
  .map((f) => JSON.parse(readFileSync(join(OUT, f), "utf8")))
  .map((m) => ({
    run: m.config.run,
    acc: m.config.accounts,
    batch: m.config.batch,
    imgs: m.summary.images,
    sec: m.summary.elapsedSec,
    imgps: m.summary.imgPerSec,
    txps: m.summary.txPerSec,
    mbps: m.summary.mbPerSec,
    p50: m.txLatencyMs.p50,
    p95: m.txLatencyMs.p95,
    p99: m.txLatencyMs.p99,
    glmImg: Number(m.summary.gasGlmPerImage),
    fail: m.summary.failed,
  }))
  .sort((a, b) => a.acc - b.acc || a.batch - b.batch)

const cols = [
  ["run", 22, (r) => r.run],
  ["acc", 4, (r) => r.acc],
  ["batch", 6, (r) => r.batch],
  ["imgs", 6, (r) => r.imgs],
  ["sec", 8, (r) => r.sec.toFixed(1)],
  ["img/s", 8, (r) => r.imgps.toFixed(2)],
  ["tx/s", 7, (r) => r.txps.toFixed(2)],
  ["MB/s", 7, (r) => r.mbps.toFixed(2)],
  ["p50ms", 8, (r) => r.p50],
  ["p95ms", 8, (r) => r.p95],
  ["p99ms", 8, (r) => r.p99],
  ["GLM/img", 12, (r) => r.glmImg.toExponential(2)],
  ["fail", 5, (r) => r.fail],
]

const pad = (s, w) => String(s).padEnd(w)
console.log(cols.map(([h, w]) => pad(h, w)).join(""))
console.log(cols.map(([, w]) => "─".repeat(w - 1) + " ").join(""))
for (const r of rows) console.log(cols.map(([, w, fn]) => pad(fn(r), w)).join(""))
