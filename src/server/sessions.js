// Session manager for the always-on server: each upload session gets its own
// event bus, stats aggregator, instrumented wallet client and engine, so
// several sessions (distinct wallets + apps) can run and be watched live at
// once. Every delta is fanned out to that session's WebSocket topic and
// persisted to SQLite; finished sessions stay browsable until deleted.

import { existsSync, statSync } from "node:fs"
import { generatePrivateKey, privateKeyToAccount } from "@atlas-chain/sdk/accounts"
import { createBus, makeInstrumentedClient } from "../uploader/instrument.js"
import { createEngine } from "../uploader/engine.js"
import { createStats } from "../uploader/stats.js"
import { getPrivateKey } from "../lib/atlas.js"

const now = () => Date.now()

export class HttpError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

export function createSessionManager({ db, version, defaultDir }) {
  const live = new Map() // id → { bus, stats, engine, sampleBuf, flushTimer }
  let publish = () => {}

  const sessionSummary = (row) => {
    const cfg = JSON.parse(row.config)
    const liveOne = live.get(row.id)
    const state = liveOne?.stats.state
    const totals = state?.totals ?? JSON.parse(row.totals ?? "null") ?? {}
    const plan = state?.plan ?? JSON.parse(row.plan ?? "null") ?? {}
    return {
      id: row.id,
      status: state?.status && state.status !== "starting" ? state.status : row.status,
      app: cfg.app,
      runId: cfg.runId,
      dir: cfg.dir,
      batch: cfg.batch,
      limit: cfg.limit,
      walletMode: cfg.walletMode,
      wallet: state?.meta?.wallet ?? row.wallet,
      createdAt: row.created_at,
      startedAt: state?.meta?.startedAt ?? row.started_at,
      finishedAt: state?.finishedAt ?? row.finished_at,
      uploaded: totals.uploaded ?? 0,
      failed: totals.failed ?? 0,
      bytes: totals.bytes ?? 0,
      planned: plan.planned ?? 0,
      error: state?.error ?? row.error,
      live: !!liveOne,
    }
  }

  const list = () => db.listSessionRows().map(sessionSummary)

  const publishList = () => publish("list", JSON.stringify({ type: "sessions", sessions: list() }))

  function validate(input) {
    const dir = String(input.dir || defaultDir || "").trim()
    if (!dir) throw new HttpError(400, "dir is required")
    if (!existsSync(dir) || !statSync(dir).isDirectory())
      throw new HttpError(400, `directory not found: ${dir}`)
    const app = String(input.app ?? "dogs").trim()
    if (!/^[a-zA-Z0-9_-]{1,32}$/.test(app))
      throw new HttpError(400, "app must be 1-32 chars of [a-zA-Z0-9_-]")
    const batch = Math.min(50, Math.max(1, Number(input.batch ?? 10) || 10))
    const limit = input.limit ? Math.max(1, Number(input.limit) || 1) : null
    const expiresDays = Math.min(365, Math.max(1, Number(input.expiresDays ?? 30) || 30))
    const minBalance = String(Number(input.minBalance ?? 0.3) || 0.3)
    const walletMode = input.walletMode === "env" ? "env" : "fresh"
    return {
      dir,
      app,
      batch,
      limit,
      expiresDays,
      minBalance,
      walletMode,
      autofund: input.autofund !== false,
      reconcile: input.reconcile !== false,
    }
  }

  function resolveWallet(config) {
    if (config.walletMode === "env") {
      let key
      try {
        key = getPrivateKey()
      } catch {
        throw new HttpError(400, "server has no ATLAS_PRIVATE_KEY configured — use a fresh wallet")
      }
      return { key, address: privateKeyToAccount(key).address, persistKey: null }
    }
    const key = generatePrivateKey()
    return { key, address: privateKeyToAccount(key).address, persistKey: key }
  }

  function guardConcurrency(config, wallet) {
    for (const [id, l] of live) {
      const cfg = l.config
      if (cfg.app === config.app)
        throw new HttpError(409, `session ${id} is already running for app "${config.app}"`)
      if (l.wallet.address.toLowerCase() === wallet.address.toLowerCase())
        throw new HttpError(409, `session ${id} is already running with wallet ${wallet.address}`)
    }
  }

  function createSession(input) {
    const config = validate(input)
    const wallet = resolveWallet(config)
    guardConcurrency(config, wallet)

    let id
    do {
      id = "s" + crypto.randomUUID().replaceAll("-", "").slice(0, 8)
    } while (db.getSessionRow(id))
    config.runId = input.runId?.trim() || id

    db.createSession({
      id,
      createdAt: now(),
      wallet: wallet.address,
      walletKey: wallet.persistKey,
      config,
    })
    start(id, config, wallet)
    publishList()
    return { id, wallet: wallet.address }
  }

  function start(id, config, wallet) {
    const bus = createBus()
    const stats = createStats(bus, { version })
    const client = makeInstrumentedClient(bus, wallet.key)
    const engine = createEngine({ client, bus, config })
    const entry = { bus, stats, engine, config, wallet, sampleBuf: [] }
    live.set(id, entry)

    const save = () => db.saveSessionState(id, stats.state)
    const flushSamples = () => {
      if (!entry.sampleBuf.length) return
      db.insertSamples(id, entry.sampleBuf)
      entry.sampleBuf = []
    }

    stats.onDelta((m) => {
      publish(`s:${id}`, JSON.stringify(m))
      switch (m.type) {
        case "sample":
          entry.sampleBuf.push(m)
          if (entry.sampleBuf.length >= 10) flushSamples()
          break
        case "batch":
          db.insertBatchWithFiles(id, m.record, m.files)
          save()
          publishList()
          break
        case "ev":
          db.insertEvent(id, m)
          break
        case "meta":
        case "plan":
        case "status":
        case "done":
          save()
          publishList()
          break
      }
    })

    entry.saveTimer = setInterval(() => {
      flushSamples()
      save()
    }, 15_000)

    engine
      .run()
      .catch((e) => bus.emit("run:error", { error: e.message ?? String(e) }))
      .finally(() => {
        clearInterval(entry.saveTimer)
        flushSamples()
        save()
        live.delete(id)
        publishList()
      })
  }

  return {
    setPublish: (fn) => (publish = fn),
    list,
    createSession,

    snapshot(id) {
      const l = live.get(id)
      if (l) return l.stats.snapshot()
      return db.reconstructSnapshot(id, { version })
    },

    stop(id) {
      const l = live.get(id)
      if (!l) throw new HttpError(409, "session is not running")
      l.engine.stop()
      return { stopping: true }
    },

    delete(id) {
      if (live.has(id)) throw new HttpError(409, "stop the session before deleting it")
      if (!db.getSessionRow(id)) throw new HttpError(404, "no such session")
      db.deleteSession(id)
      publishList()
      return { deleted: true }
    },

    stopAll() {
      for (const l of live.values()) l.engine.stop()
    },

    liveCount: () => live.size,
  }
}
