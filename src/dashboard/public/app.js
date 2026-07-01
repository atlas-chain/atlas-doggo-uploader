/* Atlas doggo uploader — live dashboard client.
   Mirrors the server's stats state over a WebSocket (full snapshot on connect,
   deltas after) and renders: progress hero, stat tiles, the three-stage
   commitment pipeline, canvas charts, recent files, event log, doggo strip. */

"use strict"

const $ = (id) => document.getElementById(id)

// Session mode: /s/<id> pages are served by the always-on server — the WS is
// scoped to that session, admin actions need the token, and there's no linger.
const SID = location.pathname.match(/^\/s\/(s[0-9a-f]{8})/)?.[1] ?? null
if (SID) $("back").hidden = false

const TOKEN_KEY = "atlas-admin-token"
const getToken = () => localStorage.getItem(TOKEN_KEY) ?? ""
function promptToken(msg = "Admin token:") {
  const t = window.prompt(msg, getToken())
  if (t != null) localStorage.setItem(TOKEN_KEY, t.trim())
  return getToken()
}

// ---------- state ----------
let S = null // mirror of server stats state
let skew = 0 // serverNow - clientNow
let wsOpen = false
let serverGone = false
const dirty = new Set()
const mark = (...zones) => {
  for (const z of zones) dirty.add(z)
  scheduleFlush()
}

const CAP = { batches: 120, recentFiles: 48, events: 150, series: 3800, latP: 800, latC: 300 }
const push = (arr, v, cap) => {
  arr.push(v)
  if (arr.length > cap) arr.splice(0, arr.length - cap)
}
const snow = () => Date.now() + skew

// ---------- formatters ----------
const fmtInt = (n) => (n == null ? "—" : Number(n).toLocaleString("en-US").replace(/,/g, " "))
const fmtBytes = (b) => {
  if (b == null) return "—"
  if (b >= 1e9) return (b / 1e9).toFixed(2) + " GB"
  if (b >= 1e6) return (b / 1e6).toFixed(1) + " MB"
  if (b >= 1e3) return (b / 1e3).toFixed(1) + " KB"
  return b + " B"
}
const fmtRate = (bps) => (bps >= 1e6 ? (bps / 1e6).toFixed(2) + " MB/s" : (bps / 1e3).toFixed(0) + " KB/s")
const fmtMs = (ms) => (ms == null ? "—" : ms >= 10000 ? (ms / 1000).toFixed(1) + "s" : Math.round(ms) + "ms")
const fmtDur = (ms) => {
  if (ms == null || ms < 0) return "—"
  const s = Math.floor(ms / 1000)
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60
  return h ? `${h}h ${String(m).padStart(2, "0")}m` : m ? `${m}m ${String(sec).padStart(2, "0")}s` : `${sec}s`
}
const fmtClock = (ms) => {
  const s = Math.max(0, Math.floor(ms / 1000))
  const m = Math.floor(s / 60)
  return `${m}:${String(s % 60).padStart(2, "0")}`
}
const fmtGlm = (wei, dp = 3) => (wei == null ? "—" : (Number(wei) / 1e18).toFixed(dp))
const shortHex = (h, n = 6) => (h ? h.slice(0, n + 2) + "…" + h.slice(-4) : "—")
const fmtTime = (t) => new Date(t).toLocaleTimeString("en-GB")
const pctl = (arr, p) => {
  if (!arr?.length) return null
  const a = [...arr].sort((x, y) => x - y)
  return a[Math.min(a.length - 1, Math.floor((p / 100) * a.length))]
}
const esc = document.createElement("div")
const text = (s) => ((esc.textContent = s ?? ""), esc.innerHTML)

const txUrl = (h) => (S?.meta ? `${S.meta.scannerUrl}/tx/${h}` : "#")
const addrUrl = (a) => (S?.meta ? `${S.meta.scannerUrl}/address/${a}` : "#")
const payloadUrl = (id, raw) => (S?.meta ? `${S.meta.payloadUrl}/payloads/${id}${raw ? "/raw" : ""}` : "#")

// ---------- websocket ----------
let retryMs = 800
function connect() {
  const ws = new WebSocket(
    `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws${SID ? `?s=${SID}` : ""}`,
  )
  ws.onopen = () => {
    wsOpen = true
    retryMs = 800
    $("conn").classList.remove("off")
  }
  ws.onmessage = (e) => handle(JSON.parse(e.data))
  ws.onclose = () => {
    wsOpen = false
    $("conn").classList.add("off")
    // one-shot mode: the process exits after its linger window — stop retrying
    const lingerOver = S?.linger && snow() > S.linger.until - 1500
    const finished = ["done", "stopped", "error"].includes(S?.status)
    if (!SID && finished && lingerOver) {
      serverGone = true
      $("offline").hidden = false
      return
    }
    setTimeout(connect, (retryMs = Math.min(5000, retryMs * 1.5)))
  }
  ws.onerror = () => ws.close()
}

function handle(m) {
  switch (m.type) {
    case "hello":
      S = m.state
      skew = m.serverNow - Date.now()
      if (!S) {
        $("waiting").textContent = `[ session ${SID ?? "?"} not found — it may have been deleted ]`
        $("waiting").hidden = false
        return
      }
      logRendered = 0
      $("log").textContent = ""
      $("waiting").hidden = !!S.meta
      mark("all")
      break
    case "meta":
      S.meta = m.meta
      $("waiting").hidden = true
      mark("head", "tiles", "foot")
      break
    case "status":
      S.status = m.status
      if (m.error) S.error = m.error
      if (m.stopRequested) S.stopRequested = true
      mark("head", "banner")
      break
    case "reconcile":
      S.reconcile = m.reconcile
      mark("progress")
      break
    case "plan":
      S.plan = m.plan
      mark("progress", "tiles")
      break
    case "balance":
      S.balanceWei = m.balanceWei
      mark("tiles")
      break
    case "fund":
      S.totals.fundCount = m.fundCount
      S.lastFundAt = m.lastFundAt
      mark("tiles")
      break
    case "current":
      S.current = m.current
      mark("pipeline", "progress")
      break
    case "chain":
      S.block = m.block
      S.totals = m.totals
      mark("tiles")
      break
    case "batch":
      push(S.batches, m.record, CAP.batches)
      for (const f of m.files) push(S.recentFiles, f, CAP.recentFiles)
      S.totals = m.totals
      if (m.block) S.block = m.block
      if (m.record.ok) {
        for (const f of m.files) if (f.ms != null) push(S.latency.payload, f.ms, CAP.latP)
        if (m.record.submitMs != null) push(S.latency.submit, m.record.submitMs, CAP.latC)
        if (m.record.confirmMs != null) push(S.latency.confirm, m.record.confirmMs, CAP.latC)
      }
      mark("progress", "tiles", "files", "doggos", "chart-batches", "pcts")
      break
    case "ev":
      push(S.events, m, CAP.events)
      mark("log")
      break
    case "sample":
      push(S.series.t, m.t, CAP.series)
      push(S.series.bps, m.bps, CAP.series)
      push(S.series.fpm, m.fpm, CAP.series)
      push(S.series.inflight, m.inflight, CAP.series)
      push(S.series.balance, m.balance, CAP.series)
      mark("chart-throughput", "chart-balance", "tiles")
      break
    case "done":
      S.doneSummary = m.doneSummary
      S.finishedAt = m.finishedAt
      mark("banner", "head", "pipeline")
      break
    case "linger":
      S.linger = m.linger
      mark("banner", "head")
      break
  }
}

// ---------- render scheduling ----------
let flushQueued = false
function scheduleFlush() {
  if (flushQueued) return
  flushQueued = true
  requestAnimationFrame(() => {
    flushQueued = false
    if (!S) return
    const all = dirty.has("all")
    const has = (z) => all || dirty.has(z)
    if (has("head")) renderHead()
    if (has("banner")) renderBanner()
    if (has("progress")) renderProgress()
    if (has("tiles")) renderTiles()
    if (has("pipeline")) renderPipeline()
    if (has("files")) renderFiles()
    if (has("log")) renderLog()
    if (has("doggos")) renderDoggos()
    if (has("pcts")) renderPcts()
    if (has("chart-throughput")) chartThroughput()
    if (has("chart-batches")) chartBatches()
    if (has("chart-balance")) chartBalance()
    if (has("foot")) renderFoot()
    dirty.clear()
  })
}

// ---------- header ----------
function renderHead() {
  const st = S.status
  const pill = $("status-pill")
  pill.textContent = st + (S.stopRequested && !["done", "stopped", "error"].includes(st) ? " · stopping" : "")
  pill.className = "pill mono " + st
  if (S.meta) {
    $("head-app").hidden = false
    $("head-app").textContent = `app ${S.meta.app}`
    const w = $("head-wallet")
    w.hidden = false
    w.textContent = shortHex(S.meta.wallet, 6)
    w.href = addrUrl(S.meta.wallet)
    w.title = S.meta.wallet
  }
  if (S.block != null) {
    $("head-block").hidden = false
    $("head-block").textContent = `block ${fmtInt(S.block)}`
  }
  $("btn-stop").hidden =
    S.historical || !["uploading", "funding", "reconciling", "starting", "running"].includes(st)
}

// ---------- banner + linger ----------
function renderBanner() {
  const b = $("banner")
  const finished = ["done", "stopped", "error", "interrupted"].includes(S.status)
  b.hidden = !finished
  $("btn-extend").hidden = !!SID // linger only exists in one-shot mode
  if (!finished) return
  b.className = "banner " + (S.status === "interrupted" ? "error" : S.status)
  const d = S.doneSummary
  $("banner-title").textContent =
    S.status === "done"
      ? "✓ run complete"
      : S.status === "stopped"
        ? "⏸ run stopped"
        : S.status === "interrupted"
          ? "✕ interrupted — server restarted mid-run"
          : "✗ run crashed"
  $("banner-body").textContent = d
    ? `${fmtInt(d.uploaded)} files uploaded (${d.failed} failed) in ${fmtDur(d.elapsedMs)} · ` +
      `${fmtBytes(S.totals.bytes)} of image data · ${fmtInt(S.totals.txCount)} transactions · ` +
      `${fmtGlm(S.totals.feeWei, 4)} ${S.meta?.currency ?? "GLM"} in fees · balance left ${d.balance != null ? Number(d.balance).toFixed(3) : "—"} ${S.meta?.currency ?? "GLM"}`
    : S.error ?? ""
}

function renderCountdowns() {
  if (!S) return
  if (S.linger) {
    const left = S.linger.until - snow()
    const label = `page exits in ${fmtClock(left)}`
    $("linger-head").hidden = false
    $("linger-head").textContent = serverGone ? "server gone" : label
    $("banner-countdown").textContent = serverGone ? "dashboard server has shut down" : label
  } else {
    $("linger-head").hidden = true
    $("banner-countdown").textContent = ""
  }
}

// ---------- progress ----------
function renderProgress() {
  const p = S.plan
  const t = S.totals
  const inBatch = S.current ? S.current.files.length : 0
  $("p-done").textContent = fmtInt(t.uploaded)
  $("p-total").textContent = fmtInt(p.planned)
  const pct = p.planned ? ((t.uploaded / p.planned) * 100) : 0
  $("p-pct").textContent = pct.toFixed(1) + "%"
  const w = (n) => (p.planned ? (100 * n) / p.planned : 0) + "%"
  $("seg-done").style.width = w(t.uploaded)
  $("seg-cur").style.width = w(inBatch)
  $("seg-fail").style.width = w(t.failed)
  const bits = []
  if (S.status === "reconciling")
    bits.push(`reconciling with chain… ${fmtInt(S.reconcile.found)} found (page ${S.reconcile.pages})`)
  if (p.filesInDir) bits.push(`${fmtInt(p.filesInDir)} in dir`)
  if (p.alreadyDone) bits.push(`${fmtInt(p.alreadyDone)} already on-chain (skipped)`)
  if (S.meta?.limit) bits.push(`limit ${fmtInt(S.meta.limit)}`)
  if (p.plannedBytes) bits.push(`${fmtBytes(p.plannedBytes)} planned`)
  if (t.failed) bits.push(`${fmtInt(t.failed)} failed`)
  $("p-sub").textContent = bits.join("   ·   ")
}

// ---------- tiles ----------
function tile(k, v, u, s, cls = "") {
  return `<div class="tile ${cls}"><span class="k">${k}</span><span class="v">${v}${u ? `<span class="u">${u}</span>` : ""}</span>${s ? `<span class="s">${s}</span>` : ""}</div>`
}
function lastAvg(arr, n) {
  const t = arr.slice(-n).filter((x) => x != null)
  return t.length ? t.reduce((a, b) => a + b, 0) / t.length : 0
}
function renderTiles() {
  const t = S.totals
  const p = S.plan
  const sr = S.series
  const bps = lastAvg(sr.bps, 5)
  const fpm = sr.fpm.at(-1) ?? 0
  const remaining = Math.max(0, p.planned - t.uploaded - t.failed)
  const finished = ["done", "stopped", "error", "interrupted"].includes(S.status)
  const endT = S.finishedAt ?? (finished ? sr.t.at(-1) : null) // interrupted: last observed sample
  const etaMs = finished || remaining <= 0 ? null : fpm > 0 ? (remaining / fpm) * 60_000 : null
  const elapsed = S.meta ? (endT ?? snow()) - S.meta.startedAt : null
  const curr = S.meta?.currency ?? "GLM"
  const avgConfirm = lastAvg(S.latency.confirm, 20)
  const avgBatch = lastAvg(S.batches.filter((b) => b.ok).map((b) => b.totalMs), 20)
  const feePerFile = t.uploaded ? Number(S.totals.feeWei) / t.uploaded / 1e18 : null

  $("tiles").innerHTML = [
    tile("uploaded", fmtInt(t.uploaded), "", `${fmtInt(remaining)} remaining`, "good"),
    tile("data on-chain", fmtBytes(t.bytes), "", `${fmtBytes(t.wireBytes)} on the wire`),
    tile("throughput", bps >= 1e6 ? (bps / 1e6).toFixed(2) : (bps / 1e3).toFixed(0), bps >= 1e6 ? "MB/s" : "KB/s", `${fmtInt(sr.inflight.at(-1) ?? 0)} uploads in flight`, "accent"),
    tile("pace", fmtInt(fpm), "files/min", avgBatch ? `batch avg ${fmtMs(avgBatch)}` : "", "accent"),
    tile("eta", etaMs != null ? fmtDur(etaMs) : "—", "", elapsed != null ? `elapsed ${fmtDur(elapsed)}` : ""),
    tile("balance", fmtGlm(S.balanceWei), curr, `${t.fundCount}× faucet drip`, Number(fmtGlm(S.balanceWei)) < 0.1 ? "warn" : ""),
    tile("fees spent", fmtGlm(t.feeWei, 4), curr, feePerFile != null ? `≈${feePerFile.toFixed(6)} ${curr}/file` : ""),
    tile("transactions", fmtInt(t.txCount), "", avgConfirm ? `receipt avg ${fmtMs(avgConfirm)}` : ""),
    tile("batches", `${fmtInt(t.batchesOk)}/${fmtInt(p.totalBatches)}`, "", t.retries ? `${t.retries} retries` : "no retries"),
    tile("failed", fmtInt(t.failed), "", t.payloadFails ? `${t.payloadFails} payload errors` : "", t.failed ? "bad" : ""),
    tile("gas used", t.gasUsed >= 1e6 ? (t.gasUsed / 1e6).toFixed(2) + "M" : fmtInt(t.gasUsed), "", `block ${fmtInt(S.block)}`),
    tile("rpc calls", fmtInt(t.rpcCalls), "", t.rpcErrors ? `${t.rpcErrors} errors` : "healthy", t.rpcErrors ? "warn" : ""),
  ].join("")
}

// ---------- pipeline ----------
function renderPipeline() {
  const cur = S.current
  const last = S.batches.at(-1)
  const stP = $("st-payload"), stC = $("st-chain"), stR = $("st-receipt")
  const arrows = document.querySelectorAll(".arrow")
  const setCls = (el, cls) => (el.className = "stage" + (cls ? " " + cls : ""))

  if (!cur) {
    $("pl-batch").textContent = last ? `#${last.i + 1} landed — idle` : "—"
    setCls(stP); setCls(stC); setCls(stR)
    arrows.forEach((a) => a.classList.remove("flow"))
    if (last?.ok) {
      $("st-payload-big").textContent = `${last.n}/${last.n}`
      $("st-payload-sub").textContent = `took ${fmtMs(last.payloadMs)} · ${fmtBytes(last.bytes)}`
      $("st-chain-big").innerHTML = last.txHash ? `<a href="${txUrl(last.txHash)}" target="_blank" rel="noopener">${shortHex(last.txHash)}</a>` : "—"
      $("st-chain-sub").textContent = `submitted in ${fmtMs(last.submitMs)}`
      $("st-receipt-big").textContent = `✓ ${fmtMs(last.confirmMs)}`
      $("st-receipt-sub").textContent = last.block ? `block ${fmtInt(last.block)} · ${fmtInt(last.gasUsed)} gas` : ""
    }
    $("st-dots").innerHTML = ""
    return
  }

  const stage = cur.stage
  $("pl-batch").textContent = `#${cur.index + 1} of ${fmtInt(S.plan.totalBatches)}${cur.attempt ? ` · attempt ${cur.attempt + 1}` : ""}`

  const nDone = cur.files.filter((f) => f.status !== "queued" && f.status !== "uploading").length
  const nUp = cur.files.filter((f) => f.status === "uploading").length
  setCls(stP, stage === "payload" || stage === "prepare" ? "active" : "landed")
  $("st-payload-big").textContent = stage === "prepare" ? "…" : `${nDone}/${cur.files.length}`
  $("st-payload-sub").textContent =
    stage === "prepare"
      ? "deriving entity keys…"
      : stage === "payload"
        ? `${nUp} in flight · ${fmtRate(lastAvg(S.series.bps, 3))}`
        : `took ${fmtMs(cur.payloadMs)}`

  const chainOn = stage === "submit"
  setCls(stC, chainOn ? "active" : stage === "confirm" || stage === "landed" ? "landed" : "")
  $("st-chain-big").innerHTML = cur.txHash
    ? `<a href="${txUrl(cur.txHash)}" target="_blank" rel="noopener">${shortHex(cur.txHash)}</a>`
    : chainOn
      ? "signing…"
      : "—"
  $("st-chain-sub").textContent = chainOn
    ? `sending tx (${fmtClock(snow() - cur.stageAt)})`
    : cur.submitMs != null
      ? `submitted in ${fmtMs(cur.submitMs)}`
      : ""

  const rcOn = stage === "confirm"
  setCls(stR, rcOn ? "active" : stage === "landed" ? "landed" : "")
  $("st-receipt-big").textContent =
    stage === "landed" ? `✓ ${fmtMs(cur.confirmMs)}` : rcOn ? fmtClock(snow() - cur.stageAt) : "—"
  $("st-receipt-sub").textContent =
    stage === "landed"
      ? `block ${fmtInt(cur.block)} · ${fmtInt(cur.gasUsed)} gas`
      : rcOn
        ? "waiting for inclusion…"
        : ""

  arrows[0]?.classList.toggle("flow", stage === "submit")
  arrows[1]?.classList.toggle("flow", stage === "confirm")

  $("st-dots").innerHTML = cur.files
    .map((f) => `<span class="dot ${f.status}" title="${text(f.name)} — ${f.status}"></span>`)
    .join("")
}

// ---------- files table ----------
function renderFiles() {
  const rows = [...S.recentFiles].slice(-15).reverse()
  $("files-body").innerHTML = rows
    .map((f) => {
      const speed = f.ms && f.size ? fmtRate((f.size / f.ms) * 1000) : "—"
      return `<tr>
        <td><span class="st-dot ${f.ok ? "ok" : "fail"}"></span></td>
        <td title="${text(f.entityKey ?? "")}">${text(f.name)}</td>
        <td class="r">${fmtBytes(f.size)}</td>
        <td class="r">${fmtMs(f.ms)}</td>
        <td class="r">${speed}</td>
        <td>${f.txHash ? `<a href="${txUrl(f.txHash)}" target="_blank" rel="noopener">${shortHex(f.txHash, 4)}</a>` : "—"}</td>
        <td>${f.payloadId ? `<a href="${payloadUrl(f.payloadId)}" target="_blank" rel="noopener">receipt ↗</a>` : "—"}</td>
      </tr>`
    })
    .join("")
}

// ---------- log ----------
let logRendered = 0
function renderLog() {
  const log = $("log")
  const startIdx = Math.max(0, S.events.length - CAP.events)
  if (logRendered > S.events.length) logRendered = 0
  if (logRendered === 0) log.textContent = ""
  for (let i = logRendered; i < S.events.length; i++) {
    const e = S.events[i]
    const ln = document.createElement("div")
    ln.className = `ln ${e.level}`
    const lt = document.createElement("span")
    lt.className = "lt"
    lt.textContent = fmtTime(e.t)
    const lm = document.createElement("span")
    lm.className = "lm"
    lm.textContent = e.msg
    ln.append(lt, lm)
    log.appendChild(ln)
  }
  while (log.children.length > CAP.events) log.removeChild(log.firstChild)
  logRendered = S.events.length
  log.scrollTop = log.scrollHeight
}

// ---------- doggos ----------
function renderDoggos() {
  const withPayload = S.recentFiles.filter((f) => f.payloadId && f.ok).slice(-14).reverse()
  $("sec-doggos").hidden = withPayload.length === 0
  $("doggos").innerHTML = withPayload
    .map(
      (f) =>
        `<a href="${payloadUrl(f.payloadId, true)}" target="_blank" rel="noopener" data-name="${text(f.name)}"><img src="${payloadUrl(f.payloadId, true)}" alt="${text(f.name)}"></a>`,
    )
    .join("")
}

// ---------- percentiles ----------
function renderPcts() {
  const groups = [
    { title: "payload upload (per file)", data: S.latency.payload, color: "var(--ark-blue)" },
    { title: "receipt wait (per batch)", data: S.latency.confirm, color: "var(--purple)" },
    { title: "tx submit (per batch)", data: S.latency.submit, color: "var(--ark-orange)" },
  ]
  $("pcts").innerHTML = groups
    .map((g) => {
      const p50 = pctl(g.data, 50), p90 = pctl(g.data, 90), p99 = pctl(g.data, 99)
      if (p50 == null) return `<div class="pct-group"><div class="pct-title">${g.title}</div><div class="pct-bars"><span class="pn">—</span><span></span><span class="pv">no data yet</span></div></div>`
      const max = Math.max(p99, 1)
      const bar = (v) => `<div class="pct-track"><div class="pct-fill" style="width:${Math.max(2, (100 * v) / max)}%;background:${g.color}"></div></div>`
      return `<div class="pct-group"><div class="pct-title">${g.title} · n=${g.data.length}</div>
        <div class="pct-bars">
          <span class="pn">p50</span>${bar(p50)}<span class="pv">${fmtMs(p50)}</span>
          <span class="pn">p90</span>${bar(p90)}<span class="pv">${fmtMs(p90)}</span>
          <span class="pn">p99</span>${bar(p99)}<span class="pv">${fmtMs(p99)}</span>
        </div></div>`
    })
    .join("")
}

// ---------- canvas charts ----------
const CH = {
  ink: "#111111",
  muted: "#6b6b6b",
  grid: "rgba(17,17,17,0.08)",
  blue: "#181ea9",
  orange: "#fe7446",
  purple: "#7a3fb8",
  green: "#1f7a4d",
  red: "#b3261e",
}

function setupCanvas(canvas) {
  const dpr = window.devicePixelRatio || 1
  // The height attribute is the design height in CSS px — but assigning
  // canvas.height below overwrites that same attribute with the dpr-scaled
  // buffer size. Cache the design height once and pin the CSS height, or on
  // dpr>1 displays every redraw would multiply the chart height by dpr.
  if (!canvas.dataset.h) canvas.dataset.h = canvas.getAttribute("height") || "190"
  const h = Number(canvas.dataset.h)
  canvas.style.height = h + "px"
  const w = canvas.clientWidth || canvas.parentElement.clientWidth - 32
  canvas.width = Math.round(w * dpr)
  canvas.height = Math.round(h * dpr)
  const ctx = canvas.getContext("2d")
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, w, h)
  ctx.font = "9.5px JetBrains Mono, monospace"
  return { ctx, w, h }
}

function niceMax(v) {
  if (v <= 0) return 1
  const exp = 10 ** Math.floor(Math.log10(v))
  const m = v / exp
  return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * exp
}

// downsample to ~width points, averaging each bucket
function bucket(arr, n) {
  if (arr.length <= n) return arr
  const out = []
  const step = arr.length / n
  for (let i = 0; i < n; i++) {
    const a = Math.floor(i * step), b = Math.max(a + 1, Math.floor((i + 1) * step))
    let sum = 0, c = 0
    for (let j = a; j < b; j++) if (arr[j] != null) { sum += arr[j]; c++ }
    out.push(c ? sum / c : null)
  }
  return out
}

function drawAxes(ctx, w, h, pad, yMax, yFmt, yMaxR, yFmtR) {
  ctx.strokeStyle = CH.grid
  ctx.fillStyle = CH.muted
  const rows = 4
  for (let i = 0; i <= rows; i++) {
    const y = pad.t + ((h - pad.t - pad.b) * i) / rows
    ctx.beginPath()
    ctx.moveTo(pad.l, y)
    ctx.lineTo(w - pad.r, y)
    ctx.stroke()
    const v = yMax * (1 - i / rows)
    ctx.textAlign = "right"
    ctx.fillText(yFmt(v), pad.l - 5, y + 3)
    if (yMaxR != null) {
      ctx.textAlign = "left"
      ctx.fillText(yFmtR(yMaxR * (1 - i / rows)), w - pad.r + 5, y + 3)
    }
  }
}

function linePath(ctx, data, x0, x1, y0, y1, yMax) {
  const n = data.length
  if (!n) return
  ctx.beginPath()
  let started = false
  for (let i = 0; i < n; i++) {
    if (data[i] == null) continue
    const x = x0 + ((x1 - x0) * i) / Math.max(1, n - 1)
    const y = y1 - (y1 - y0) * Math.min(1, data[i] / yMax)
    if (!started) { ctx.moveTo(x, y); started = true } else ctx.lineTo(x, y)
  }
}

function chartThroughput() {
  const canvas = $("ch-throughput")
  const { ctx, w, h } = setupCanvas(canvas)
  const pad = { l: 44, r: 44, t: 8, b: 18 }
  const N = Math.max(60, Math.floor(w - pad.l - pad.r))
  const mbps = bucket(S.series.bps.map((b) => b / 1e6), N)
  const fpm = bucket(S.series.fpm, N)
  const yMax = niceMax(Math.max(0.1, ...mbps.filter((x) => x != null)))
  const yMaxR = niceMax(Math.max(10, ...fpm.filter((x) => x != null)))
  drawAxes(ctx, w, h, pad, yMax, (v) => v.toFixed(1), yMaxR, (v) => String(Math.round(v)))

  // MB/s — blue area + line
  linePath(ctx, mbps, pad.l, w - pad.r, pad.t, h - pad.b, yMax)
  ctx.strokeStyle = CH.blue
  ctx.lineWidth = 1.6
  ctx.stroke()
  ctx.lineTo(w - pad.r, h - pad.b)
  ctx.lineTo(pad.l, h - pad.b)
  ctx.closePath()
  ctx.fillStyle = "rgba(24,30,169,0.10)"
  ctx.fill()

  // files/min — orange line (right axis)
  linePath(ctx, fpm, pad.l, w - pad.r, pad.t, h - pad.b, yMaxR)
  ctx.strokeStyle = CH.orange
  ctx.lineWidth = 1.4
  ctx.stroke()

  // time labels
  const t = S.series.t
  if (t.length > 1) {
    ctx.fillStyle = CH.muted
    ctx.textAlign = "left"
    ctx.fillText(fmtTime(t[0]), pad.l, h - 5)
    ctx.textAlign = "right"
    ctx.fillText(fmtTime(t.at(-1)), w - pad.r, h - 5)
  }
}

function chartBatches() {
  const canvas = $("ch-batches")
  const { ctx, w, h } = setupCanvas(canvas)
  const pad = { l: 44, r: 10, t: 8, b: 18 }
  const recs = S.batches.slice(-48)
  if (!recs.length) return drawAxes(ctx, w, h, pad, 1, (v) => v.toFixed(0) + "s")
  const totalOf = (r) => (r.ok ? (r.payloadMs ?? 0) + (r.submitMs ?? 0) + (r.confirmMs ?? 0) : 0)
  const yMaxMs = niceMax(Math.max(1000, ...recs.map(totalOf)))
  drawAxes(ctx, w, h, pad, yMaxMs / 1000, (v) => v.toFixed(1) + "s")
  const plotW = w - pad.l - pad.r
  const bw = Math.min(22, (plotW / recs.length) * 0.72)
  const gap = plotW / recs.length
  const y1 = h - pad.b
  recs.forEach((r, i) => {
    const x = pad.l + gap * i + (gap - bw) / 2
    if (!r.ok) {
      ctx.fillStyle = CH.red
      ctx.fillRect(x, y1 - 6, bw, 6)
      return
    }
    let acc = 0
    for (const [key, color] of [["payloadMs", CH.blue], ["submitMs", CH.orange], ["confirmMs", CH.purple]]) {
      const v = r[key] ?? 0
      const hh = ((y1 - pad.t) * v) / yMaxMs
      ctx.fillStyle = color
      ctx.fillRect(x, y1 - acc - hh, bw, Math.max(hh - 0.5, 0))
      acc += hh
    }
  })
  ctx.fillStyle = CH.muted
  ctx.textAlign = "left"
  ctx.fillText(`batch #${recs[0].i + 1}`, pad.l, h - 5)
  ctx.textAlign = "right"
  ctx.fillText(`#${recs.at(-1).i + 1}`, w - pad.r, h - 5)
}

function chartBalance() {
  const canvas = $("ch-balance")
  const { ctx, w, h } = setupCanvas(canvas)
  const pad = { l: 44, r: 10, t: 8, b: 18 }
  const N = Math.max(60, Math.floor(w - pad.l - pad.r))
  const bal = bucket(S.series.balance, N)
  const vals = bal.filter((x) => x != null)
  const yMax = niceMax(Math.max(0.5, ...vals))
  drawAxes(ctx, w, h, pad, yMax, (v) => v.toFixed(2))
  linePath(ctx, bal, pad.l, w - pad.r, pad.t, h - pad.b, yMax)
  ctx.strokeStyle = CH.green
  ctx.lineWidth = 1.6
  ctx.stroke()
  // faucet drips: balance jumps up
  ctx.fillStyle = CH.orange
  for (let i = 1; i < bal.length; i++) {
    if (bal[i] != null && bal[i - 1] != null && bal[i] - bal[i - 1] > 0.05) {
      const x = pad.l + ((w - pad.l - pad.r) * i) / Math.max(1, bal.length - 1)
      const y = h - pad.b - (h - pad.b - pad.t) * Math.min(1, bal[i] / yMax)
      ctx.beginPath()
      ctx.arc(x, y, 3.5, 0, Math.PI * 2)
      ctx.fill()
    }
  }
  const t = S.series.t
  if (t.length > 1) {
    ctx.fillStyle = CH.muted
    ctx.textAlign = "left"
    ctx.fillText(fmtTime(t[0]), pad.l, h - 5)
    ctx.textAlign = "right"
    ctx.fillText(fmtTime(t.at(-1)), w - pad.r, h - 5)
  }
  $("lg-cur").textContent = S.meta?.currency ?? "GLM"
}

// ---------- footer ----------
function renderFoot() {
  if (!S.meta) return
  $("ft-net").textContent = `chain ${S.meta.chainId} · rpc ${S.meta.rpcUrl} · payload ${S.meta.payloadUrl} · run "${S.meta.runId}" · expires ${S.meta.expiresDays}d`
  $("ft-ver").textContent = `atlas-doggo-uploader ${S.meta.version || ""}`
}

// ---------- actions ----------
$("btn-stop").addEventListener("click", async () => {
  const btn = $("btn-stop")
  if (!SID) {
    btn.disabled = true
    btn.textContent = "stopping…"
    await fetch("/api/stop", { method: "POST" }).catch(() => {})
    return
  }
  // session mode: stopping is an admin action
  const token = getToken() || promptToken()
  const res = await fetch(`/api/sessions/${SID}/stop`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
  }).catch(() => null)
  if (res?.status === 401) {
    promptToken("Wrong or missing admin token — try again:")
    return
  }
  if (res?.ok) {
    btn.disabled = true
    btn.textContent = "stopping…"
  }
})
$("btn-extend").addEventListener("click", async () => {
  await fetch("/api/linger?min=60", { method: "POST" }).catch(() => {})
})

// ---------- tickers ----------
setInterval(() => {
  if (!S) return
  renderCountdowns()
  if (S.current) renderPipeline() // live stage timers
  if (S.meta && !S.finishedAt) mark("tiles") // elapsed/eta tick
}, 1000)

window.addEventListener("resize", () => mark("chart-throughput", "chart-batches", "chart-balance"))

connect()
