// Atlas doggo uploader — always-on server mode.
//
// Keeps the dashboard up permanently: browse past sessions (persisted in
// SQLite), watch running ones in real time, and — with the admin token —
// start, stop and delete upload sessions from the web UI or the API.
//
//   bun scripts/server.mjs [--port 3000] [--db out/sessions.db] [--data-dir /data]
//
// Admin token: set ATLAS_ADMIN_TOKEN, or a random one is generated and
// printed at boot. Viewing is public; mutations need the token.

import { parseArgs } from "node:util"
import { existsSync, readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join, isAbsolute } from "node:path"
import { openDb } from "../src/server/db.js"
import { createSessionManager } from "../src/server/sessions.js"
import { startService } from "../src/server/service.js"
import { getPrivateKey } from "../src/lib/atlas.js"
import { DOGS_DIR } from "../src/lib/images.js"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")

const USAGE = `Atlas doggo uploader — always-on server with persistent sessions.

Usage:
  [ATLAS_ADMIN_TOKEN=…] bun scripts/server.mjs [options]

Options:
  --port <n>        listen port                         (default $PORT or 3000)
  --db <path>       sqlite database                     (default out/sessions.db)
  --data-dir <path> default PNG directory for new sessions
                    (default $ATLAS_DATA_DIR, /data, or the local dog dataset)
  -h, --help        show this help
`

let values
try {
  values = parseArgs({
    options: {
      port: { type: "string", default: process.env.PORT ?? "3000" },
      db: { type: "string", default: join(ROOT, "out", "sessions.db") },
      "data-dir": { type: "string" },
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

const abs = (p) => (isAbsolute(p) ? p : join(process.cwd(), p))
const defaultDir =
  (values["data-dir"] && abs(values["data-dir"])) ||
  process.env.ATLAS_DATA_DIR ||
  (existsSync("/data") ? "/data" : DOGS_DIR)

let hasEnvWallet = true
try {
  getPrivateKey()
} catch {
  hasEnvWallet = false
}

const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"))
const db = openDb(abs(values.db))
const interrupted = db.markInterruptedOnBoot()

const manager = createSessionManager({ db, version: `v${pkg.version}`, defaultDir })
const { url, token } = startService({
  manager,
  port: Number(values.port),
  adminToken: process.env.ATLAS_ADMIN_TOKEN,
  defaultDir,
  hasEnvWallet,
})

console.log(`Atlas doggo uploader server v${pkg.version}`)
console.log(`  dashboard : ${url}`)
console.log(`  database  : ${abs(values.db)}`)
console.log(`  data dir  : ${defaultDir}${existsSync(defaultDir) ? "" : "  (missing — pass --data-dir or mount /data)"}`)
console.log(`  wallet    : ${hasEnvWallet ? "ATLAS_PRIVATE_KEY configured" : "none — sessions use fresh throwaway wallets"}`)
if (interrupted?.changes) console.log(`  recovered : ${interrupted.changes} session(s) marked interrupted after restart`)
if (process.env.ATLAS_ADMIN_TOKEN) console.log(`  admin     : token from ATLAS_ADMIN_TOKEN`)
else console.log(`  admin     : generated token (set ATLAS_ADMIN_TOKEN to pin one)\n              ${token}`)

const shutdown = () => {
  console.log("\nshutting down — stopping running sessions…")
  manager.stopAll()
  setTimeout(() => process.exit(0), 500)
}
process.on("SIGINT", shutdown)
process.on("SIGTERM", shutdown)
