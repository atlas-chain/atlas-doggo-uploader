// Atlas doggo uploader — CLI entry point.
//
// Runs the upload engine and (by default) the live dashboard in one process:
// the engine streams every PNG in a directory onto Atlas in batched
// transactions while the dashboard shows per-file progress, the commitment
// pipeline (payload upload → tx → receipt), throughput/latency charts, wallet
// balance and an event log — and stays reachable for --linger-min after the
// run so you can inspect the result.
//
//   ATLAS_PRIVATE_KEY=0x… bun scripts/upload-dir.mjs --dir /path/to/pngs

import { parseArgs } from "node:util"
import { existsSync, readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join, isAbsolute } from "node:path"
import { createBus, makeInstrumentedClient } from "../src/uploader/instrument.js"
import { createEngine } from "../src/uploader/engine.js"
import { createStats } from "../src/uploader/stats.js"
import { startDashboard } from "../src/dashboard/server.js"
import { DOGS_DIR } from "../src/lib/images.js"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")

const USAGE = `Atlas doggo uploader — push every PNG in a directory to Atlas, with a live dashboard.

Usage:
  ATLAS_PRIVATE_KEY=0x… bun scripts/upload-dir.mjs --dir /path/to/pngs [options]

Options:
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
  --linger-min <n>      keep the dashboard up n minutes after the run finishes
                        (default 60; 0 = exit immediately)
  --no-dashboard        headless: no web dashboard
  -h, --help            show this help
`

let values
try {
  values = parseArgs({
    options: {
      dir: { type: "string" },
      batch: { type: "string", default: "10" },
      app: { type: "string", default: "dogs" },
      run: { type: "string" },
      limit: { type: "string" },
      "expires-days": { type: "string", default: "30" },
      "min-balance": { type: "string", default: "0.3" },
      "no-autofund": { type: "boolean", default: false },
      "no-reconcile": { type: "boolean", default: false },
      port: { type: "string", default: process.env.PORT ?? "3000" },
      "linger-min": { type: "string", default: "60" },
      "no-dashboard": { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  }).values
} catch (e) {
  console.error(`${e.message}\n\n${USAGE}`)
  process.exit(1)
}

if (values.help) {
  console.log(USAGE)
  process.exit(0)
}

const dir = values.dir
  ? isAbsolute(values.dir)
    ? values.dir
    : join(process.cwd(), values.dir)
  : DOGS_DIR
if (!existsSync(dir)) {
  console.error(`directory not found: ${dir}\n\n${USAGE}`)
  process.exit(1)
}

const config = {
  dir,
  batch: Math.min(50, Math.max(1, Number(values.batch))),
  app: values.app,
  runId: values.run ?? values.app,
  expiresDays: Number(values["expires-days"]),
  minBalance: values["min-balance"],
  autofund: !values["no-autofund"],
  reconcile: !values["no-reconcile"],
  limit: values.limit ? Math.max(1, Number(values.limit)) : null,
}

const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"))

// ---- wire everything together ----------------------------------------------
const bus = createBus()
const stats = createStats(bus, { version: `v${pkg.version}` })
const client = makeInstrumentedClient(bus)
const engine = createEngine({ client, bus, config })

let dash = null
if (!values["no-dashboard"]) {
  dash = startDashboard({
    stats,
    engine,
    port: Number(values.port),
    lingerMin: Number(values["linger-min"]),
    onExit: () => process.exit(exitCode),
  })
}

// ---- console renderer -------------------------------------------------------
const fmtGlm = (wei) => (wei == null ? "?" : (Number(wei) / 1e18).toFixed(3))
let progressActive = false
const clearProgress = () => {
  if (progressActive) {
    process.stdout.write("\r" + " ".repeat(100) + "\r")
    progressActive = false
  }
}

bus.on("run:init", (d) => {
  console.log(`Atlas doggo uploader ${stats.state.version}`)
  console.log(`  wallet  : ${d.wallet}`)
  console.log(`  dir     : ${d.dir}`)
  console.log(
    `  batch   : ${d.batch}   app: ${d.app}   run: ${d.runId}   expires: ${d.expiresDays}d` +
      (d.limit ? `   limit: ${d.limit}` : ""),
  )
  if (dash) console.log(`  dashboard → ${dash.url}`)
  console.log("")
})
bus.on("reconcile:page", ({ found, page }) => {
  process.stdout.write(`  reconciling with chain… ${found} found (page ${page})\r`)
  progressActive = true
})
stats.onDelta((m) => {
  if (m.type !== "ev") return
  clearProgress()
  const tag = m.level === "error" ? "✗" : m.level === "warn" ? "!" : "·"
  console.log(`  ${tag} ${m.msg}`)
})

const progressTimer = setInterval(() => {
  const s = stats.state
  if (s.status !== "uploading" || !s.plan.planned) return
  const fpm = s.series.fpm.at(-1) ?? 0
  const remaining = s.plan.planned - s.totals.uploaded - s.totals.failed
  const eta = fpm > 0 ? remaining / fpm : null
  const mbps = ((s.series.bps.at(-1) ?? 0) / 1e6).toFixed(2)
  process.stdout.write(
    `  ${s.totals.uploaded}/${s.plan.planned} uploaded (${s.totals.failed} failed) · ${fpm} img/min · ${mbps} MB/s · balance ${fmtGlm(s.balanceWei)} · ETA ${eta != null ? eta.toFixed(0) + "m" : "?"}   \r`,
  )
  progressActive = true
}, 5000)

// ---- signals ----------------------------------------------------------------
let finished = false
let exitCode = 0
const onStop = () => {
  if (finished || engine.stopping) process.exit(exitCode || 1)
  engine.stop()
}
process.on("SIGINT", onStop)
process.on("SIGTERM", onStop)

// ---- run --------------------------------------------------------------------
try {
  const { uploaded, failed, stopped } = await engine.run()
  clearProgress()
  console.log(`\n── ${stopped ? "stopped" : "done"} ──`)
  console.log(`uploaded this run : ${uploaded}  (${failed} failed)`)
  console.log(`fees spent        : ${fmtGlm(stats.state.totals.feeWei)} GLM in ${stats.state.totals.txCount} txs`)
  console.log(`balance left      : ${fmtGlm(stats.state.balanceWei)} GLM`)
  if (failed) exitCode = 2
} catch (e) {
  clearProgress()
  bus.emit("run:error", { error: e.message ?? String(e) })
  console.error("\nuploader crashed:", e)
  exitCode = 1
} finally {
  clearInterval(progressTimer)
  finished = true
}

if (dash) {
  console.log(`\ndashboard stays up at ${dash.url} — Ctrl-C to exit now`)
  dash.beginLinger()
} else {
  process.exit(exitCode)
}
