// The uploader's observability core, tested with a synthetic event stream:
// the bus fan-out, and the stats aggregator's commitment-pipeline state
// machine (prepare → payload → submit → confirm → landed → done).

import { test } from "bun:test"
import assert from "node:assert/strict"
import { createBus } from "../src/uploader/instrument.js"
import { createStats } from "../src/uploader/stats.js"

test("bus delivers typed and wildcard events", () => {
  const bus = createBus()
  const seen = []
  bus.on("a", (d) => seen.push(["a", d.x]))
  bus.on("*", (t) => seen.push(["*", t]))
  bus.emit("a", { x: 1 })
  bus.emit("b", { x: 2 })
  assert.deepEqual(seen, [["a", 1], ["*", "a"], ["*", "b"]])
})

test("stats walks a batch through the commitment pipeline", () => {
  const bus = createBus()
  const stats = createStats(bus, { version: "vtest" })

  bus.emit("run:init", {
    wallet: "0xabc", dir: "/d", app: "t", runId: "t", batch: 2,
    expiresDays: 1, autofund: true, limit: null, chainId: 42069,
    currency: "GLM", rpcUrl: "r", payloadUrl: "p", scannerUrl: "s",
    startedAt: Date.now(),
  })
  bus.emit("run:phase", { phase: "upload" })
  bus.emit("plan", { filesInDir: 2, alreadyDone: 0, planned: 2, plannedBytes: 300, totalBatches: 1 })

  const files = [
    { name: "a.png", size: 100, entityKey: "0x01" },
    { name: "b.png", size: 200, entityKey: "0x02" },
  ]
  bus.emit("batch:start", { index: 0, attempt: 0, files })
  assert.equal(stats.state.current.stage, "prepare")

  bus.emit("payload:start", { entityKey: "0x01", wireBytes: 140 })
  assert.equal(stats.state.current.stage, "payload")
  assert.equal(stats.state.current.files[0].status, "uploading")

  bus.emit("payload:start", { entityKey: "0x02", wireBytes: 270 })
  bus.emit("payload:done", { entityKey: "0x01", wireBytes: 140, ms: 50 })
  assert.equal(stats.state.current.stage, "payload")
  bus.emit("payload:done", { entityKey: "0x02", wireBytes: 270, ms: 70 })
  assert.equal(stats.state.current.stage, "submit")
  assert.equal(stats.state.totals.wireBytes, 410)

  bus.emit("tx:submitted", { txHash: "0xdead", ms: 30 })
  assert.equal(stats.state.current.stage, "confirm")
  assert.equal(stats.state.current.txHash, "0xdead")
  assert.equal(stats.state.current.files[0].status, "committing")

  bus.emit("tx:receipt", { txHash: "0xdead", block: 7, gasUsed: 1000, feeWei: "5000", reverted: false })
  assert.equal(stats.state.current.stage, "landed")
  assert.equal(stats.state.block, 7)
  assert.equal(stats.state.totals.feeWei, "5000")

  bus.emit("batch:done", {
    index: 0, ms: 500, txHash: "0xdead",
    files: files.map((f) => ({ ...f, payloadId: "pid-" + f.name })),
  })
  assert.equal(stats.state.current, null)
  assert.equal(stats.state.totals.uploaded, 2)
  assert.equal(stats.state.totals.bytes, 300)
  assert.equal(stats.state.batches.length, 1)
  assert.equal(stats.state.batches[0].ok, true)
  assert.equal(stats.state.recentFiles.length, 2)
  assert.equal(stats.state.recentFiles[0].ms, 50)

  bus.emit("run:done", { uploaded: 2, failed: 0, stopped: false, elapsedMs: 1000 })
  assert.equal(stats.state.status, "done")
  stats.stop()
})

test("stats attributes unlabeled payloads and survives a retry", () => {
  const bus = createBus()
  const stats = createStats(bus, {})
  bus.emit("run:init", { wallet: "0x", dir: "", app: "", runId: "", batch: 1, startedAt: Date.now() })
  bus.emit("batch:start", {
    index: 0, attempt: 0,
    files: [{ name: "x.png", size: 10, entityKey: null }],
  })
  // entityKey extraction failed → falls back to first queued/uploading file
  bus.emit("payload:start", { entityKey: null, wireBytes: 14 })
  assert.equal(stats.state.current.files[0].status, "uploading")
  bus.emit("payload:fail", { entityKey: null, ms: 5, error: "boom" })
  assert.equal(stats.state.current.files[0].status, "failed")

  bus.emit("batch:retry", { index: 0, attempt: 0, error: "boom" })
  assert.equal(stats.state.totals.retries, 1)
  bus.emit("batch:start", { index: 0, attempt: 1, files: [{ name: "x.png", size: 10, entityKey: "0x9" }] })
  assert.equal(stats.state.current.attempt, 1)
  assert.equal(stats.state.current.files[0].status, "queued")
  stats.stop()
})
