// SQLite persistence for upload sessions (bun:sqlite). Every session — its
// config, rolled-up totals, 1 Hz samples, per-batch timings, per-file results
// and event log — survives server restarts, so old runs stay browsable in the
// dashboard forever unless an admin explicitly deletes them.

import { Database } from "bun:sqlite"
import { mkdirSync, chmodSync } from "node:fs"
import { dirname } from "node:path"

const SCHEMA = `
PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS sessions (
  id           TEXT PRIMARY KEY,
  created_at   INTEGER NOT NULL,
  started_at   INTEGER,
  finished_at  INTEGER,
  status       TEXT NOT NULL,      -- pending|running|done|stopped|error|interrupted
  error        TEXT,
  wallet       TEXT,
  wallet_key   TEXT,               -- only set for generated throwaway wallets (testnet)
  config       TEXT NOT NULL,      -- JSON
  meta         TEXT,               -- JSON (run:init payload)
  plan         TEXT,               -- JSON
  totals       TEXT,               -- JSON (rolling, final at finish)
  done_summary TEXT,               -- JSON
  balance_wei  TEXT,
  block        INTEGER
);
CREATE TABLE IF NOT EXISTS samples (
  session_id TEXT NOT NULL, t INTEGER NOT NULL,
  bps INTEGER, fpm REAL, inflight INTEGER, balance REAL
);
CREATE INDEX IF NOT EXISTS idx_samples ON samples(session_id, t);
CREATE TABLE IF NOT EXISTS batches (
  session_id TEXT NOT NULL, i INTEGER, n INTEGER, bytes INTEGER,
  payload_ms INTEGER, submit_ms INTEGER, confirm_ms INTEGER, total_ms INTEGER,
  tx_hash TEXT, block INTEGER, gas_used INTEGER, ok INTEGER, at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_batches ON batches(session_id, at);
CREATE TABLE IF NOT EXISTS files (
  session_id TEXT NOT NULL, name TEXT, size INTEGER, entity_key TEXT,
  payload_id TEXT, tx_hash TEXT, ms INTEGER, ok INTEGER, at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_files ON files(session_id, at);
CREATE TABLE IF NOT EXISTS events (
  session_id TEXT NOT NULL, t INTEGER, level TEXT, msg TEXT
);
CREATE INDEX IF NOT EXISTS idx_events ON events(session_id, t);
`

const J = (v) => (v == null ? null : JSON.stringify(v))
const P = (v, fallback = null) => {
  if (v == null) return fallback
  try {
    return JSON.parse(v)
  } catch {
    return fallback
  }
}

// bun:sqlite binds named params only when keys carry the "$" prefix — wrap
// every statement so call sites can use plain keys (undefined → NULL).
function prefixed(params = {}) {
  const out = {}
  for (const k in params) out["$" + k] = params[k] === undefined ? null : params[k]
  return out
}

export function openDb(path) {
  mkdirSync(dirname(path), { recursive: true })
  const db = new Database(path)
  db.exec(SCHEMA)
  try {
    chmodSync(path, 0o600) // throwaway wallet keys live in here
  } catch {}

  const Q = (sql) => {
    const st = db.query(sql)
    return {
      run: (p) => st.run(prefixed(p)),
      get: (p) => st.get(prefixed(p)),
      all: (p) => st.all(prefixed(p)),
    }
  }

  const q = {
    insertSession: Q(
      `INSERT INTO sessions (id, created_at, status, wallet, wallet_key, config)
       VALUES ($id, $createdAt, $status, $wallet, $walletKey, $config)`,
    ),
    updateSession: Q(
      `UPDATE sessions SET status=$status, error=$error, started_at=$startedAt,
        finished_at=$finishedAt, meta=$meta, plan=$plan, totals=$totals,
        done_summary=$doneSummary, balance_wei=$balanceWei, block=$block, wallet=$wallet
       WHERE id=$id`,
    ),
    getSession: Q(`SELECT * FROM sessions WHERE id=$id`),
    listSessions: Q(`SELECT * FROM sessions ORDER BY created_at DESC`),
    markInterrupted: Q(
      `UPDATE sessions SET status='interrupted',
        error=COALESCE(error, 'server restarted while the session was running'),
        finished_at=COALESCE(finished_at,
          (SELECT MAX(t) FROM samples WHERE session_id=sessions.id), created_at)
       WHERE status NOT IN ('done','stopped','error','interrupted')`,
    ),
    insertSample: Q(
      `INSERT INTO samples VALUES ($sid, $t, $bps, $fpm, $inflight, $balance)`,
    ),
    insertBatch: Q(
      `INSERT INTO batches VALUES ($sid, $i, $n, $bytes, $payloadMs, $submitMs,
        $confirmMs, $totalMs, $txHash, $block, $gasUsed, $ok, $at)`,
    ),
    insertFile: Q(
      `INSERT INTO files VALUES ($sid, $name, $size, $entityKey, $payloadId,
        $txHash, $ms, $ok, $at)`,
    ),
    insertEvent: Q(`INSERT INTO events VALUES ($sid, $t, $level, $msg)`),
    // "last N in chronological order" — rowid is insertion order, which is
    // chronological here and (unlike `at`) never ties.
    lastSamples: Q(
      `SELECT * FROM (SELECT rowid AS _r, * FROM samples WHERE session_id=$sid ORDER BY _r DESC LIMIT $n)
       ORDER BY _r ASC`,
    ),
    lastBatches: Q(
      `SELECT * FROM (SELECT rowid AS _r, * FROM batches WHERE session_id=$sid ORDER BY _r DESC LIMIT $n)
       ORDER BY _r ASC`,
    ),
    lastFiles: Q(
      `SELECT * FROM (SELECT rowid AS _r, * FROM files WHERE session_id=$sid ORDER BY _r DESC LIMIT $n)
       ORDER BY _r ASC`,
    ),
    fileMs: Q(
      `SELECT ms FROM (SELECT rowid AS _r, ms FROM files WHERE session_id=$sid AND ok=1 AND ms IS NOT NULL
        ORDER BY _r DESC LIMIT $n) ORDER BY _r ASC`,
    ),
    lastEvents: Q(
      `SELECT * FROM (SELECT rowid AS _r, * FROM events WHERE session_id=$sid ORDER BY _r DESC LIMIT $n)
       ORDER BY _r ASC`,
    ),
    deleteSession: db.transaction((id) => {
      for (const table of ["samples", "batches", "files", "events"])
        db.query(`DELETE FROM ${table} WHERE session_id=?`).run(id)
      db.query(`DELETE FROM sessions WHERE id=?`).run(id)
    }),
  }

  const insertSamples = db.transaction((sid, rows) => {
    for (const s of rows)
      q.insertSample.run({
        sid,
        t: s.t,
        bps: s.bps ?? null,
        fpm: s.fpm ?? null,
        inflight: s.inflight ?? null,
        balance: s.balance ?? null,
      })
  })

  const insertBatchWithFiles = db.transaction((sid, record, files) => {
    q.insertBatch.run({
      sid,
      i: record.i,
      n: record.n,
      bytes: record.bytes ?? null,
      payloadMs: record.payloadMs ?? null,
      submitMs: record.submitMs ?? null,
      confirmMs: record.confirmMs ?? null,
      totalMs: record.totalMs ?? null,
      txHash: record.txHash ?? null,
      block: record.block ?? null,
      gasUsed: record.gasUsed ?? null,
      ok: record.ok ? 1 : 0,
      at: record.at,
    })
    for (const f of files ?? [])
      q.insertFile.run({
        sid,
        name: f.name ?? null,
        size: f.size ?? null,
        entityKey: f.entityKey ?? null,
        payloadId: f.payloadId ?? null,
        txHash: f.txHash ?? null,
        ms: f.ms ?? null,
        ok: f.ok ? 1 : 0,
        at: f.at,
      })
  })

  return {
    raw: db,

    markInterruptedOnBoot: () => q.markInterrupted.run(),

    createSession: ({ id, createdAt, wallet, walletKey, config }) =>
      q.insertSession.run({
        id,
        createdAt,
        status: "pending",
        wallet: wallet ?? null,
        walletKey: walletKey ?? null,
        config: J(config),
      }),

    /** Persist the rolled-up view of a session from its live stats state. */
    saveSessionState: (id, state, { startedAt = null } = {}) =>
      q.updateSession.run({
        id,
        status: state.status === "starting" ? "running" : state.status,
        error: state.error ?? null,
        startedAt: state.meta?.startedAt ?? startedAt,
        finishedAt: state.finishedAt ?? null,
        meta: J(state.meta),
        plan: J(state.plan),
        totals: J(state.totals),
        doneSummary: J(state.doneSummary),
        balanceWei: state.balanceWei ?? null,
        block: state.block ?? null,
        wallet: state.meta?.wallet ?? null,
      }),

    insertSamples,
    insertBatchWithFiles,
    insertEvent: (sid, e) => q.insertEvent.run({ sid, t: e.t, level: e.level, msg: e.msg }),

    getSessionRow: (id) => q.getSession.get({ id }),
    listSessionRows: () => q.listSessions.all(),
    deleteSession: (id) => q.deleteSession(id),

    /**
     * Rebuild a stats-state-shaped snapshot for a finished/interrupted session,
     * so the dashboard renders history exactly like a live run.
     */
    reconstructSnapshot(id, { version = "" } = {}) {
      const row = q.getSession.get({ id })
      if (!row) return null
      const samples = q.lastSamples.all({ sid: id, n: 3800 })
      const batches = q.lastBatches.all({ sid: id, n: 120 })
      const files = q.lastFiles.all({ sid: id, n: 48 })
      const events = q.lastEvents.all({ sid: id, n: 150 })
      const payloadMs = q.fileMs.all({ sid: id, n: 800 }).map((r) => r.ms)
      const okBatches = batches.filter((b) => b.ok)
      return {
        version,
        historical: true,
        meta: P(row.meta),
        status: row.status,
        stopRequested: false,
        error: row.error,
        finishedAt: row.finished_at,
        reconcile: { found: 0, pages: 0, onChain: null, newly: null },
        plan: P(row.plan, { filesInDir: 0, alreadyDone: 0, planned: 0, plannedBytes: 0, totalBatches: 0 }),
        totals: P(row.totals, {
          uploaded: 0, failed: 0, bytes: 0, wireBytes: 0, txCount: 0, gasUsed: 0,
          feeWei: "0", batchesOk: 0, batchesFailed: 0, retries: 0, rpcCalls: 0,
          rpcErrors: 0, fundCount: 0, payloadCount: 0, payloadFails: 0,
        }),
        balanceWei: row.balance_wei,
        lastFundAt: null,
        block: row.block,
        current: null,
        batches: batches.map((b) => ({
          i: b.i, n: b.n, bytes: b.bytes, payloadMs: b.payload_ms, submitMs: b.submit_ms,
          confirmMs: b.confirm_ms, totalMs: b.total_ms, txHash: b.tx_hash, block: b.block,
          gasUsed: b.gas_used, ok: !!b.ok, at: b.at,
        })),
        recentFiles: files.map((f) => ({
          name: f.name, size: f.size, entityKey: f.entity_key, payloadId: f.payload_id,
          txHash: f.tx_hash, ms: f.ms, ok: !!f.ok, at: f.at,
        })),
        events: events.map((e) => ({ t: e.t, level: e.level, msg: e.msg })),
        series: {
          t: samples.map((s) => s.t),
          bps: samples.map((s) => s.bps),
          fpm: samples.map((s) => s.fpm),
          inflight: samples.map((s) => s.inflight),
          balance: samples.map((s) => s.balance),
        },
        latency: {
          payload: payloadMs,
          submit: okBatches.map((b) => b.submit_ms).filter((v) => v != null),
          confirm: okBatches.map((b) => b.confirm_ms).filter((v) => v != null),
        },
        linger: null,
        doneSummary: P(row.done_summary),
      }
    },

    close: () => db.close(),
  }
}
