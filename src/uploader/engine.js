// The upload engine: pushes every PNG in a directory to Atlas in batches from
// a single wallet, exactly like the original upload-dir script — resumable via
// checkpoint, duplicate-proof via on-chain reconciliation, self-funding from
// the faucet — but headless: every observable moment is emitted on the bus so
// the console renderer and the live dashboard can both follow along.

import { readFileSync, readdirSync, appendFileSync, existsSync, mkdirSync, statSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"
import { formatEther, parseEther } from "@atlas-chain/sdk"
import { ExpirationTime } from "@atlas-chain/sdk/utils"
import { CHAIN, RPC_URL, PAYLOAD_URL, SCANNER_URL } from "../lib/atlas.js"
import { claimWithCooldown } from "../lib/faucet.js"
import { queryEntitiesRaw } from "../lib/read.js"
import { deriveNextEntityKeys } from "./instrument.js"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..")
const now = () => Date.now()

// numeric-aware sort so dog_2 < dog_10
const numKey = (n) => {
  const m = /(\d+)/.exec(n)
  return m ? Number(m[1]) : Number.MAX_SAFE_INTEGER
}

/**
 * Run one upload job. `client` must come from makeInstrumentedClient(bus) so
 * payload/tx events land on the same bus.
 *
 * config: { dir, batch, app, runId, expiresDays, minBalance, autofund,
 *           reconcile, limit }
 * Returns { uploaded, failed, stopped }. Call engine.stop() to finish the
 * current batch and wind down gracefully.
 */
export function createEngine({ client, bus, config }) {
  const {
    dir,
    batch: BATCH,
    app: APP,
    runId: RUN_ID,
    expiresDays,
    minBalance,
    autofund: AUTOFUND,
    reconcile: RECONCILE,
    limit,
  } = config

  const EXPIRES = ExpirationTime.fromDays(expiresDays)
  const MIN_WEI = parseEther(String(minBalance))
  const address = client.account.address
  const balance = () => client.getBalance({ address })

  mkdirSync(join(ROOT, "out"), { recursive: true })
  const CHECKPOINT = join(ROOT, "out", `upload-${APP}.checkpoint`)
  const FAILURES = join(ROOT, "out", `upload-${APP}.failures`)

  let stopping = false

  const log = (level, msg) => bus.emit("log", { level, msg })

  function loadCheckpoint() {
    if (!existsSync(CHECKPOINT)) return new Set()
    return new Set(readFileSync(CHECKPOINT, "utf8").split("\n").filter(Boolean))
  }

  async function emitBalance() {
    try {
      const wei = await balance()
      bus.emit("balance", { wei: wei.toString() })
      return wei
    } catch {
      return null
    }
  }

  // Names of entities this wallet already uploaded for this app, paginated to
  // exhaustion (the RPC caps pages at ~200 regardless of the requested limit).
  async function chainUploadedNames() {
    const names = new Set()
    let cursor
    let pages = 0
    for (;;) {
      let page
      try {
        page = await queryEntitiesRaw(client, {
          filters: { app: APP },
          ownedBy: address,
          limit: 1000,
          cursor,
          withMetadata: false,
        })
      } catch (e) {
        log("warn", `reconcile: chain query failed (${e.message}) — using local checkpoint only`)
        break
      }
      for (const e of page.entities) {
        const n = e.attributes.find((a) => a.key === "name")?.value
        if (n) names.add(n)
      }
      pages++
      bus.emit("reconcile:page", { found: names.size, page: pages })
      if (!page.cursor || page.cursor === cursor || page.entities.length === 0) break
      cursor = page.cursor
    }
    return names
  }

  async function ensureBalance() {
    if (!AUTOFUND) return
    let bal = await balance()
    bus.emit("balance", { wei: bal.toString() })
    while (bal < MIN_WEI && !stopping) {
      bus.emit("fund:need", { balance: formatEther(bal), min: String(minBalance) })
      try {
        await claimWithCooldown(address, {
          onWait: (s) => bus.emit("fund:wait", { seconds: s }),
        })
        bus.emit("fund:claimed", {})
      } catch (e) {
        bus.emit("fund:error", { error: e.message })
        await new Promise((r) => setTimeout(r, 30000))
      }
      for (let i = 0; i < 30; i++) {
        await new Promise((r) => setTimeout(r, 1000))
        if ((await balance()) > bal) break
      }
      bal = await balance()
      bus.emit("fund:done", { balance: formatEther(bal) })
      bus.emit("balance", { wei: bal.toString() })
    }
  }

  async function run() {
    const startedAt = now()
    bus.emit("run:init", {
      wallet: address,
      dir,
      app: APP,
      runId: RUN_ID,
      batch: BATCH,
      expiresDays,
      autofund: AUTOFUND,
      limit: limit ?? null,
      chainId: CHAIN.id,
      currency: CHAIN.nativeCurrency.symbol,
      rpcUrl: RPC_URL,
      payloadUrl: PAYLOAD_URL,
      scannerUrl: SCANNER_URL,
      startedAt,
    })
    await emitBalance()

    const all = readdirSync(dir)
      .filter((n) => n.toLowerCase().endsWith(".png"))
      .sort((a, b) => numKey(a) - numKey(b))
    if (!all.length) throw new Error(`no PNGs in ${dir}`)

    const checkpoint = loadCheckpoint()
    const done = new Set(checkpoint)
    if (RECONCILE) {
      bus.emit("run:phase", { phase: "reconcile" })
      const onChain = await chainUploadedNames()
      const newly = [...onChain].filter((n) => !checkpoint.has(n))
      for (const n of onChain) done.add(n)
      if (newly.length) appendFileSync(CHECKPOINT, newly.join("\n") + "\n")
      bus.emit("reconcile:done", { onChain: onChain.size, newly: newly.length })
    }

    let todo = all.filter((n) => !done.has(n))
    if (limit && todo.length > limit) todo = todo.slice(0, limit)

    const sizes = new Map(todo.map((n) => [n, statSync(join(dir, n)).size]))
    const plannedBytes = [...sizes.values()].reduce((a, b) => a + b, 0)
    bus.emit("plan", {
      filesInDir: all.length,
      alreadyDone: done.size,
      planned: todo.length,
      plannedBytes,
      totalBatches: Math.ceil(todo.length / BATCH),
    })

    let uploaded = 0
    let failed = 0

    if (todo.length) {
      bus.emit("run:phase", { phase: "upload" })

      for (let i = 0; i < todo.length && !stopping; i += BATCH) {
        const slice = todo.slice(i, i + BATCH)
        const batchIndex = Math.floor(i / BATCH)
        await ensureBalance()
        if (stopping) break

        const creates = slice.map((name) => ({
          payload: new Uint8Array(readFileSync(join(dir, name))),
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
          // Predict entity keys so live payload uploads can be labeled by file.
          let keys = []
          try {
            keys = await deriveNextEntityKeys(client, slice.length)
          } catch {
            /* labels degrade gracefully */
          }
          const t0 = now()
          bus.emit("batch:start", {
            index: batchIndex,
            attempt,
            files: slice.map((name, j) => ({
              name,
              size: sizes.get(name),
              entityKey: keys[j] ?? null,
            })),
          })

          try {
            const result = await client.mutateEntities({ creates })
            ok = true
            const payloadIdByKey = Object.fromEntries(
              (result.payloadReceipts ?? []).map((r) => [r.entityKey, r.payload?.id]),
            )
            bus.emit("batch:done", {
              index: batchIndex,
              ms: now() - t0,
              txHash: result.txHash,
              files: slice.map((name, j) => ({
                name,
                size: sizes.get(name),
                entityKey: result.createdEntities[j] ?? keys[j] ?? null,
                payloadId: payloadIdByKey[result.createdEntities[j]] ?? null,
              })),
            })
          } catch (e) {
            const msg = e.message || String(e)
            if (/insufficient funds|Insufficient/i.test(msg) && AUTOFUND) {
              bus.emit("batch:retry", { index: batchIndex, attempt, error: "insufficient funds" })
              await ensureBalance()
              attempt-- // funding pause doesn't consume a retry
            } else if (attempt === 2) {
              failed += slice.length
              appendFileSync(
                FAILURES,
                slice.map((n) => `${n}\t${msg.replace(/\s+/g, " ").slice(0, 200)}`).join("\n") + "\n",
              )
              bus.emit("batch:failed", {
                index: batchIndex,
                files: slice.map((name) => ({ name, size: sizes.get(name) })),
                error: msg.slice(0, 300),
              })
            } else {
              bus.emit("batch:retry", { index: batchIndex, attempt, error: msg.slice(0, 300) })
              await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)))
            }
          }
        }

        if (ok) {
          appendFileSync(CHECKPOINT, slice.join("\n") + "\n")
          uploaded += slice.length
        }
      }
    }

    const bal = await emitBalance()
    bus.emit("run:done", {
      uploaded,
      failed,
      stopped: stopping,
      elapsedMs: now() - startedAt,
      totalOnCheckpoint: loadCheckpoint().size,
      filesInDir: all.length,
      balance: bal != null ? formatEther(bal) : null,
    })
    return { uploaded, failed, stopped: stopping }
  }

  return {
    run,
    stop() {
      if (!stopping) {
        stopping = true
        bus.emit("run:stopping", {})
      }
    },
    get stopping() {
      return stopping
    },
  }
}
