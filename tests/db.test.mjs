// SQLite persistence round-trip: create a session, stream stats into it,
// reconstruct the dashboard snapshot, survive a "restart", delete it.

import { test, expect } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { openDb } from "../src/server/db.js"

function tempDb() {
  const dir = mkdtempSync(join(tmpdir(), "doggo-db-"))
  return { db: openDb(join(dir, "t.db")), cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

const fakeState = (over = {}) => ({
  meta: { wallet: "0xW", app: "t", runId: "r", startedAt: 1000, scannerUrl: "s", payloadUrl: "p" },
  status: "uploading",
  error: null,
  finishedAt: null,
  plan: { filesInDir: 5, alreadyDone: 0, planned: 5, plannedBytes: 500, totalBatches: 3 },
  totals: { uploaded: 2, failed: 0, bytes: 200, wireBytes: 270, txCount: 1, feeWei: "9" },
  balanceWei: "1000000000000000000",
  block: 42,
  doneSummary: null,
  ...over,
})

test("session state, batches, samples and events round-trip through sqlite", () => {
  const { db, cleanup } = tempDb()
  try {
    db.createSession({
      id: "sabc12345",
      createdAt: 999,
      wallet: "0xW",
      walletKey: "0xkey",
      config: { app: "t", dir: "/d", batch: 2, walletMode: "fresh" },
    })
    db.saveSessionState("sabc12345", fakeState())
    db.insertSamples("sabc12345", [
      { t: 1001, bps: 100, fpm: 6, inflight: 2, balance: 1.0 },
      { t: 1002, bps: 200, fpm: 6, inflight: 0, balance: 0.99 },
    ])
    db.insertBatchWithFiles(
      "sabc12345",
      { i: 0, n: 2, bytes: 200, payloadMs: 40, submitMs: 100, confirmMs: 2000, totalMs: 2200, txHash: "0xT", block: 42, gasUsed: 5, ok: true, at: 1003 },
      [
        { name: "a.png", size: 100, entityKey: "0x1", payloadId: "p1", txHash: "0xT", ms: 20, ok: true, at: 1003 },
        { name: "b.png", size: 100, entityKey: "0x2", payloadId: "p2", txHash: "0xT", ms: 25, ok: true, at: 1003 },
      ],
    )
    db.insertEvent("sabc12345", { t: 1004, level: "info", msg: "hi" })
    db.saveSessionState("sabc12345", fakeState({ status: "done", finishedAt: 2000, doneSummary: { uploaded: 2, failed: 0, elapsedMs: 1000 } }))

    const snap = db.reconstructSnapshot("sabc12345", { version: "vX" })
    expect(snap.historical).toBe(true)
    expect(snap.status).toBe("done")
    expect(snap.meta.wallet).toBe("0xW")
    expect(snap.plan.planned).toBe(5)
    expect(snap.totals.uploaded).toBe(2)
    expect(snap.series.t).toEqual([1001, 1002])
    expect(snap.series.bps).toEqual([100, 200])
    expect(snap.batches.length).toBe(1)
    expect(snap.batches[0].confirmMs).toBe(2000)
    expect(snap.recentFiles.map((f) => f.name)).toEqual(["a.png", "b.png"])
    expect(snap.latency.payload).toEqual([20, 25])
    expect(snap.latency.confirm).toEqual([2000])
    expect(snap.events[0].msg).toBe("hi")
    expect(snap.doneSummary.uploaded).toBe(2)

    const rows = db.listSessionRows()
    expect(rows.length).toBe(1)
    expect(rows[0].wallet_key).toBe("0xkey")

    db.deleteSession("sabc12345")
    expect(db.listSessionRows().length).toBe(0)
    expect(db.reconstructSnapshot("sabc12345")).toBe(null)
  } finally {
    cleanup()
  }
})

test("running sessions are marked interrupted after a restart", () => {
  const { db, cleanup } = tempDb()
  try {
    db.createSession({ id: "sdead0000", createdAt: 1, config: { app: "x" } })
    db.createSession({ id: "sdone0000", createdAt: 2, config: { app: "y" } })
    db.saveSessionState("sdead0000", fakeState({ status: "uploading" })) // killed mid-run
    db.saveSessionState("sdone0000", fakeState({ status: "done", finishedAt: 5 }))
    db.markInterruptedOnBoot()
    const row = db.getSessionRow("sdead0000")
    expect(row.status).toBe("interrupted")
    expect(row.error).toContain("restarted")
    expect(db.getSessionRow("sdone0000").status).toBe("done") // terminal states untouched
  } finally {
    cleanup()
  }
})
