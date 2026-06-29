// Production uploader: push every PNG in a directory to Atlas, in order, in
// batches, from a single wallet. Built to run unattended for hours:
//   - resumable: a checkpoint file records uploaded files; restarts skip them
//   - self-sustaining: auto-tops-up from the faucet when balance runs low
//   - resilient: retries transient errors, skips persistently-failing batches
//   - graceful: Ctrl-C finishes the current batch, flushes, and reports
//
// Usage:
//   ATLAS_PRIVATE_KEY=0x... node scripts/upload-dir.mjs --dir /path/to/pngs \
//       [--batch 10] [--app dogs] [--expires-days 30] [--min-balance 0.3] [--no-autofund]
//
// The viewer can then show just this run via the owner (wallet) address.

import { parseArgs } from "node:util"
import { readFileSync, readdirSync, appendFileSync, existsSync, mkdirSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join, basename, isAbsolute } from "node:path"
import { formatEther, parseEther } from "@atlas-chain/sdk"
import { ExpirationTime } from "@atlas-chain/sdk/utils"
import { makeWalletClient, accountAddress } from "../src/lib/atlas.js"
import { claimWithCooldown } from "../src/lib/faucet.js"
import { DOGS_DIR } from "../src/lib/images.js"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const now = () => Date.now()

const { values } = parseArgs({
  options: {
    dir: { type: "string" },
    batch: { type: "string", default: "10" },
    app: { type: "string", default: "dogs" },
    run: { type: "string" },
    "expires-days": { type: "string", default: "30" },
    "min-balance": { type: "string", default: "0.3" },
    "no-autofund": { type: "boolean", default: false },
  },
})

const DIR = values.dir ? (isAbsolute(values.dir) ? values.dir : join(process.cwd(), values.dir)) : DOGS_DIR
const BATCH = Math.min(50, Math.max(1, Number(values.batch)))
const APP = values.app
const RUN_ID = values.run ?? APP
const EXPIRES = ExpirationTime.fromDays(Number(values["expires-days"]))
const MIN_WEI = parseEther(values["min-balance"])
const AUTOFUND = !values["no-autofund"]

const address = accountAddress()
const client = makeWalletClient()
const balance = () => client.getBalance({ address })

// numeric-aware sort so dog_2 < dog_10 ("po kolei")
const numKey = (n) => {
  const m = /(\d+)/.exec(n)
  return m ? Number(m[1]) : Number.MAX_SAFE_INTEGER
}

mkdirSync(join(ROOT, "out"), { recursive: true })
const CHECKPOINT = join(ROOT, "out", `upload-${APP}.checkpoint`)
const FAILURES = join(ROOT, "out", `upload-${APP}.failures`)

function loadCheckpoint() {
  if (!existsSync(CHECKPOINT)) return new Set()
  return new Set(readFileSync(CHECKPOINT, "utf8").split("\n").filter(Boolean))
}

async function ensureBalance() {
  if (!AUTOFUND) return
  let bal = await balance()
  while (bal < MIN_WEI) {
    console.log(`\n  balance ${formatEther(bal)} GLM < ${values["min-balance"]} — topping up from faucet…`)
    try {
      await claimWithCooldown(address, { onWait: (s) => process.stdout.write(`  faucet cooldown ${s}s…\n`) })
    } catch (e) {
      console.error(`  faucet top-up failed: ${e.message} — retrying in 30s`)
      await new Promise((r) => setTimeout(r, 30000))
    }
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 1000))
      if ((await balance()) > bal) break
    }
    bal = await balance()
    console.log(`  balance now ${formatEther(bal)} GLM`)
  }
}

let stopping = false
process.on("SIGINT", () => {
  if (stopping) process.exit(1)
  stopping = true
  console.log("\n\n⏸  stopping after current batch… (Ctrl-C again to force)")
})

async function main() {
  console.log(`Atlas directory uploader`)
  console.log(`  wallet  : ${address}`)
  console.log(`  dir     : ${DIR}`)
  console.log(`  batch   : ${BATCH}   app: ${APP}   run: ${RUN_ID}   expires: ${values["expires-days"]}d`)
  console.log(`  balance : ${formatEther(await balance())} GLM   autofund: ${AUTOFUND}\n`)

  const all = readdirSync(DIR).filter((n) => n.toLowerCase().endsWith(".png")).sort((a, b) => numKey(a) - numKey(b))
  if (!all.length) throw new Error(`no PNGs in ${DIR}`)

  const done = loadCheckpoint()
  const todo = all.filter((n) => !done.has(n))
  console.log(`${all.length} PNGs in dir, ${done.size} already uploaded, ${todo.length} to go\n`)
  if (!todo.length) {
    console.log("nothing to do — directory already fully uploaded for this app.")
    return
  }

  const t0 = now()
  let uploaded = 0
  let failed = 0
  let lastLog = 0

  for (let i = 0; i < todo.length && !stopping; i += BATCH) {
    const slice = todo.slice(i, i + BATCH)
    await ensureBalance()

    const creates = slice.map((name) => ({
      payload: new Uint8Array(readFileSync(join(DIR, name))),
      contentType: "image/png",
      attributes: [
        { key: "app", value: APP },
        { key: "name", value: name },
        { key: "run", value: RUN_ID },
        { key: "seq", value: numKey(name) },
      ],
      expiresIn: EXPIRES,
    }))

    let ok = false
    for (let attempt = 0; attempt < 3 && !ok && !stopping; attempt++) {
      try {
        await client.mutateEntities({ creates })
        ok = true
      } catch (e) {
        const msg = e.message || String(e)
        if (/insufficient funds|Insufficient/i.test(msg) && AUTOFUND) {
          await ensureBalance()
        } else {
          if (attempt === 2) {
            failed += slice.length
            appendFileSync(FAILURES, slice.map((n) => `${n}\t${msg.replace(/\s+/g, " ").slice(0, 200)}`).join("\n") + "\n")
            console.error(`\n  ✗ batch failed (${slice.length} imgs) after retries: ${msg.slice(0, 120)}`)
          } else {
            await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)))
          }
        }
      }
    }

    if (ok) {
      appendFileSync(CHECKPOINT, slice.join("\n") + "\n")
      uploaded += slice.length
    }

    if (now() - lastLog > 5000 || i + BATCH >= todo.length) {
      lastLog = now()
      const secs = (now() - t0) / 1000
      const rate = uploaded / secs
      const remaining = todo.length - uploaded - failed
      const eta = rate > 0 ? remaining / rate : 0
      process.stdout.write(
        `  ${uploaded}/${todo.length} uploaded (${failed} failed) · ${rate.toFixed(1)} img/s · ETA ${(eta / 60).toFixed(0)}m       \r`,
      )
    }
  }

  const secs = (now() - t0) / 1000
  console.log(`\n\n── ${stopping ? "stopped" : "done"} ──`)
  console.log(`uploaded this run : ${uploaded}  (${failed} failed)`)
  console.log(`total in dataset  : ${loadCheckpoint().size}/${all.length}`)
  console.log(`elapsed           : ${(secs / 60).toFixed(1)} min  ·  ${(uploaded / secs).toFixed(2)} img/s`)
  console.log(`balance left      : ${formatEther(await balance())} GLM`)
  console.log(`\nview only this wallet:  OWNER=${address} npm run viewer -- --port 8799`)
}

main().catch((e) => {
  console.error("\nuploader crashed:", e)
  process.exit(1)
})
