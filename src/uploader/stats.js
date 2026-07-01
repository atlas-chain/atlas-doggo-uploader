// Turns the raw event stream of an upload run into the dashboard's state:
// counters, the live commitment pipeline (payload → tx → receipt), per-batch
// timing records, a rolling 1 Hz time series, recent files and an event log.
// The dashboard server broadcasts the deltas this module emits and hands the
// full snapshot to every client that connects mid-run.

const now = () => Date.now()

const RING = {
  batches: 120,
  recentFiles: 48,
  events: 150,
  series: 3800, // ~63 min of 1 Hz samples
  latPayload: 800,
  latChain: 300,
}

function push(arr, item, cap) {
  arr.push(item)
  if (arr.length > cap) arr.splice(0, arr.length - cap)
}

export function createStats(bus, { version = "" } = {}) {
  const state = {
    version,
    meta: null,
    status: "starting", // starting|reconciling|funding|uploading|done|stopped|error
    stopRequested: false,
    error: null,
    finishedAt: null,
    reconcile: { found: 0, pages: 0, onChain: null, newly: null },
    plan: { filesInDir: 0, alreadyDone: 0, planned: 0, plannedBytes: 0, totalBatches: 0 },
    totals: {
      uploaded: 0,
      failed: 0,
      bytes: 0,
      wireBytes: 0,
      txCount: 0,
      gasUsed: 0,
      feeWei: "0",
      batchesOk: 0,
      batchesFailed: 0,
      retries: 0,
      rpcCalls: 0,
      rpcErrors: 0,
      fundCount: 0,
      payloadCount: 0,
      payloadFails: 0,
    },
    balanceWei: null,
    lastFundAt: null,
    block: null,
    current: null,
    batches: [],
    recentFiles: [],
    events: [],
    series: { t: [], bps: [], fpm: [], inflight: [], balance: [] },
    latency: { payload: [], submit: [], confirm: [] },
    linger: null,
    doneSummary: null,
  }

  const listeners = []
  const emit = (type, data) => {
    for (const fn of listeners) fn({ type, ...data })
  }

  // ---- event log -----------------------------------------------------------
  const logLine = (level, msg) => {
    const entry = { t: now(), level, msg }
    push(state.events, entry, RING.events)
    emit("ev", entry)
  }

  // ---- live "current batch" object, broadcast with a trailing throttle -----
  let currentDirty = false
  let currentTimer = null
  const touchCurrent = () => {
    currentDirty = true
    if (currentTimer) return
    currentTimer = setTimeout(() => {
      currentTimer = null
      if (currentDirty) {
        currentDirty = false
        emit("current", { current: state.current })
      }
    }, 80)
  }

  const setStatus = (status) => {
    if (state.status === status) return
    state.status = status
    emit("status", { status, error: state.error })
  }

  // per-batch scratch: entityKey → file, phase timestamps
  let keyToFile = new Map()
  let batchClock = null
  let inflight = 0
  const doneStamps = [] // {t, n} of completed uploads, for files/min

  // ---- throughput sampler (1 Hz) -------------------------------------------
  let prevWire = 0
  let prevT = now()
  let sampler = null
  const startSampler = () => {
    if (sampler) return
    sampler = setInterval(() => {
      const t = now()
      const dt = (t - prevT) / 1000 || 1
      const bps = Math.max(0, Math.round((state.totals.wireBytes - prevWire) / dt))
      prevWire = state.totals.wireBytes
      prevT = t
      while (doneStamps.length && doneStamps[0].t < t - 120_000) doneStamps.shift()
      const fpm = doneStamps.filter((d) => d.t > t - 60_000).reduce((a, d) => a + d.n, 0)
      const balance = state.balanceWei == null ? null : Number(state.balanceWei) / 1e18
      const s = state.series
      push(s.t, t, RING.series)
      push(s.bps, bps, RING.series)
      push(s.fpm, fpm, RING.series)
      push(s.inflight, inflight, RING.series)
      push(s.balance, balance, RING.series)
      emit("sample", { t, bps, fpm, inflight, balance })
    }, 1000)
  }
  const stopSampler = () => {
    if (sampler) clearInterval(sampler)
    sampler = null
  }

  // ---- bus wiring -----------------------------------------------------------
  bus.on("run:init", (d) => {
    state.meta = { ...d, version }
    emit("meta", { meta: state.meta })
    logLine("info", `run started · wallet ${d.wallet} · app "${d.app}" · batch ${d.batch}`)
    startSampler()
  })

  bus.on("run:phase", ({ phase }) => {
    if (phase === "reconcile") setStatus("reconciling")
    if (phase === "upload") setStatus("uploading")
  })

  bus.on("reconcile:page", ({ found, page }) => {
    state.reconcile.found = found
    state.reconcile.pages = page
    emit("reconcile", { reconcile: state.reconcile })
  })

  bus.on("reconcile:done", ({ onChain, newly }) => {
    state.reconcile.onChain = onChain
    state.reconcile.newly = newly
    emit("reconcile", { reconcile: state.reconcile })
    logLine("info", `reconcile: ${onChain} already on-chain (${newly} not in local checkpoint)`)
  })

  bus.on("plan", (d) => {
    state.plan = d
    emit("plan", { plan: d })
    logLine(
      "info",
      `${d.filesInDir} PNGs in dir · ${d.alreadyDone} already uploaded · ${d.planned} to go (${(d.plannedBytes / 1e6).toFixed(1)} MB, ${d.totalBatches} batches)`,
    )
  })

  bus.on("balance", ({ wei }) => {
    state.balanceWei = wei
    emit("balance", { balanceWei: wei })
  })

  bus.on("fund:need", ({ balance, min }) => {
    setStatus("funding")
    logLine("warn", `balance ${balance} below ${min} — claiming from faucet`)
  })
  bus.on("fund:wait", ({ seconds }) => logLine("info", `faucet cooldown — waiting ${seconds}s`))
  bus.on("fund:error", ({ error }) => logLine("error", `faucet claim failed: ${error} — retrying in 30s`))
  bus.on("fund:claimed", () => {
    state.totals.fundCount++
    state.lastFundAt = now()
  })
  bus.on("fund:done", ({ balance }) => {
    logLine("info", `faucet drip received — balance now ${balance}`)
    emit("fund", { fundCount: state.totals.fundCount, lastFundAt: state.lastFundAt })
    if (state.plan.planned) setStatus("uploading")
  })

  bus.on("rpc", ({ ok }) => {
    state.totals.rpcCalls++
    if (!ok) state.totals.rpcErrors++
  })

  bus.on("batch:start", ({ index, attempt, files }) => {
    batchClock = { t0: now(), payloadT0: null, submitT0: null, confirmT0: null }
    keyToFile = new Map()
    state.current = {
      index,
      attempt,
      stage: "prepare",
      stageAt: now(),
      startedAt: now(),
      txHash: null,
      payloadMs: null,
      submitMs: null,
      confirmMs: null,
      files: files.map((f) => ({ ...f, status: "queued", ms: null })),
    }
    for (const f of state.current.files) if (f.entityKey) keyToFile.set(f.entityKey, f)
    if (attempt > 0) logLine("warn", `batch #${index + 1}: retry attempt ${attempt + 1}`)
    touchCurrent()
  })

  const fileFor = (entityKey, status) => {
    const cur = state.current
    if (!cur) return null
    return (
      (entityKey && keyToFile.get(entityKey)) ||
      cur.files.find((f) => f.status === status) ||
      null
    )
  }

  bus.on("payload:start", ({ entityKey }) => {
    inflight++
    const cur = state.current
    if (!cur) return
    if (cur.stage === "prepare") {
      cur.stage = "payload"
      cur.stageAt = now()
      batchClock.payloadT0 = now()
    }
    const f = fileFor(entityKey, "queued")
    if (f) {
      f.status = "uploading"
      f.startedAt = now()
    }
    touchCurrent()
  })

  bus.on("payload:done", ({ entityKey, wireBytes, ms }) => {
    inflight = Math.max(0, inflight - 1)
    state.totals.wireBytes += wireBytes
    state.totals.payloadCount++
    push(state.latency.payload, ms, RING.latPayload)
    const cur = state.current
    if (!cur) return
    const f = fileFor(entityKey, "uploading")
    if (f) {
      f.status = "uploaded"
      f.ms = ms
      f.wireBytes = wireBytes
    }
    if (cur.files.every((x) => x.status !== "queued" && x.status !== "uploading")) {
      cur.stage = "submit"
      cur.stageAt = now()
      cur.payloadMs = now() - (batchClock.payloadT0 ?? cur.startedAt)
      batchClock.submitT0 = now()
    }
    touchCurrent()
  })

  bus.on("payload:fail", ({ entityKey, ms, error }) => {
    inflight = Math.max(0, inflight - 1)
    state.totals.payloadFails++
    const f = fileFor(entityKey, "uploading")
    if (f) {
      f.status = "failed"
      f.ms = ms
    }
    logLine("warn", `payload upload failed (${error ?? "?"}) — batch will retry`)
    touchCurrent()
  })

  bus.on("tx:submitted", ({ txHash, ms }) => {
    state.totals.txCount++
    push(state.latency.submit, ms, RING.latChain)
    const cur = state.current
    if (!cur) return
    cur.txHash = txHash
    cur.stage = "confirm"
    cur.stageAt = now()
    cur.submitMs = now() - (batchClock.submitT0 ?? cur.startedAt)
    batchClock.confirmT0 = now()
    for (const f of cur.files) if (f.status === "uploaded") f.status = "committing"
    touchCurrent()
  })

  bus.on("tx:receipt", ({ txHash, block, gasUsed, feeWei, reverted }) => {
    state.block = block
    state.totals.gasUsed += gasUsed ?? 0
    state.totals.feeWei = (BigInt(state.totals.feeWei) + BigInt(feeWei ?? 0)).toString()
    const cur = state.current
    if (cur && cur.txHash === txHash) {
      cur.stage = "landed"
      cur.stageAt = now()
      cur.confirmMs = now() - (batchClock.confirmT0 ?? cur.startedAt)
      cur.block = block
      cur.gasUsed = gasUsed
      push(state.latency.confirm, cur.confirmMs, RING.latChain)
      touchCurrent()
    }
    if (reverted) logLine("error", `tx ${txHash} reverted`)
    emit("chain", { block, totals: state.totals })
  })

  bus.on("batch:done", ({ index, ms, txHash, files }) => {
    const cur = state.current
    const record = {
      i: index,
      n: files.length,
      bytes: files.reduce((a, f) => a + (f.size ?? 0), 0),
      payloadMs: cur?.payloadMs ?? null,
      submitMs: cur?.submitMs ?? null,
      confirmMs: cur?.confirmMs ?? null,
      totalMs: ms,
      txHash,
      block: cur?.block ?? state.block,
      gasUsed: cur?.gasUsed ?? null,
      ok: true,
      at: now(),
    }
    push(state.batches, record, RING.batches)
    state.totals.uploaded += files.length
    state.totals.bytes += record.bytes
    state.totals.batchesOk++
    doneStamps.push({ t: now(), n: files.length })

    const msByName = new Map((cur?.files ?? []).map((f) => [f.name, f.ms]))
    const newFiles = files.map((f) => ({
      name: f.name,
      size: f.size,
      entityKey: f.entityKey,
      payloadId: f.payloadId,
      txHash,
      ms: msByName.get(f.name) ?? null,
      ok: true,
      at: now(),
    }))
    for (const f of newFiles) push(state.recentFiles, f, RING.recentFiles)

    state.current = null
    touchCurrent()
    emit("batch", { record, files: newFiles, totals: state.totals, block: state.block })
  })

  bus.on("batch:retry", ({ index, attempt, error }) => {
    state.totals.retries++
    logLine("warn", `batch #${index + 1} attempt ${attempt + 1} failed: ${error}`)
  })

  bus.on("batch:failed", ({ index, files, error }) => {
    state.totals.failed += files.length
    state.totals.batchesFailed++
    const record = {
      i: index,
      n: files.length,
      bytes: files.reduce((a, f) => a + (f.size ?? 0), 0),
      totalMs: null,
      ok: false,
      at: now(),
    }
    push(state.batches, record, RING.batches)
    const newFiles = files.map((f) => ({ ...f, ok: false, at: now() }))
    for (const f of newFiles) push(state.recentFiles, f, RING.recentFiles)
    state.current = null
    touchCurrent()
    logLine("error", `batch #${index + 1} failed permanently (${files.length} files): ${error}`)
    emit("batch", { record, files: newFiles, totals: state.totals, block: state.block })
  })

  bus.on("run:stopping", () => {
    state.stopRequested = true
    logLine("warn", "stop requested — finishing current batch")
    emit("status", { status: state.status, stopRequested: true })
  })

  bus.on("run:done", (d) => {
    state.finishedAt = now()
    state.doneSummary = d
    setStatus(d.stopped ? "stopped" : "done")
    logLine(
      "info",
      `run ${d.stopped ? "stopped" : "complete"} — ${d.uploaded} uploaded, ${d.failed} failed in ${(d.elapsedMs / 60000).toFixed(1)} min`,
    )
    emit("done", { doneSummary: d, finishedAt: state.finishedAt })
    stopSampler()
  })

  bus.on("run:error", ({ error }) => {
    state.error = error
    state.finishedAt = now()
    setStatus("error")
    logLine("error", `run crashed: ${error}`)
    stopSampler()
  })

  return {
    state,
    snapshot: () => state,
    onDelta: (fn) => listeners.push(fn),
    setLinger(until, totalMs) {
      state.linger = until ? { until, totalMs } : null
      emit("linger", { linger: state.linger })
    },
    log: logLine,
    stop: stopSampler,
  }
}
