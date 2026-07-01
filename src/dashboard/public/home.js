/* Home page: live session list + admin controls (start / stop / delete).
   Viewing is public; mutations send the admin token from localStorage as a
   Bearer header, prompting for it on first use or after a 401. */

"use strict"

const $ = (id) => document.getElementById(id)
let sessions = []
let skew = 0
let retryMs = 800

// ---------- admin token ----------
const TOKEN_KEY = "atlas-admin-token"
const getToken = () => localStorage.getItem(TOKEN_KEY) ?? ""
function promptToken(msg = "Admin token:") {
  const t = window.prompt(msg, getToken())
  if (t != null) localStorage.setItem(TOKEN_KEY, t.trim())
  return getToken()
}
$("btn-admin").addEventListener("click", () => {
  promptToken("Admin token (stored in this browser):")
})

async function authFetch(url, opts = {}, retried = false) {
  const token = getToken() || promptToken()
  const res = await fetch(url, {
    ...opts,
    headers: { ...(opts.headers ?? {}), authorization: `Bearer ${token}` },
  })
  if (res.status === 401 && !retried) {
    promptToken("Wrong or missing admin token — try again:")
    return authFetch(url, opts, true)
  }
  return res
}

// ---------- formatters ----------
const fmtInt = (n) => (n == null ? "—" : Number(n).toLocaleString("en-US").replace(/,/g, " "))
const fmtBytes = (b) => {
  if (!b) return "0 B"
  if (b >= 1e9) return (b / 1e9).toFixed(2) + " GB"
  if (b >= 1e6) return (b / 1e6).toFixed(1) + " MB"
  return (b / 1e3).toFixed(0) + " KB"
}
const shortHex = (h) => (h ? h.slice(0, 8) + "…" + h.slice(-4) : "—")
const rel = (t) => {
  if (!t) return "—"
  const s = Math.max(0, Math.floor((Date.now() + skew - t) / 1000))
  if (s < 60) return s + "s ago"
  if (s < 3600) return Math.floor(s / 60) + "m ago"
  if (s < 86400) return Math.floor(s / 3600) + "h ago"
  return Math.floor(s / 86400) + "d ago"
}
const dur = (a, b) => {
  if (!a) return "—"
  const ms = (b ?? Date.now() + skew) - a
  const s = Math.floor(ms / 1000)
  if (s < 60) return s + "s"
  if (s < 3600) return Math.floor(s / 60) + "m " + (s % 60) + "s"
  return Math.floor(s / 3600) + "h " + Math.floor((s % 3600) / 60) + "m"
}
const esc = document.createElement("div")
const text = (s) => ((esc.textContent = s ?? ""), esc.innerHTML)

// ---------- websocket ----------
function connect() {
  const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`)
  ws.onopen = () => {
    retryMs = 800
    $("conn").classList.remove("off")
  }
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data)
    if (m.type === "hello-list") {
      skew = m.serverNow - Date.now()
      sessions = m.sessions
      if (m.defaults?.dir && !$("f-dir").value) $("f-dir").value = m.defaults.dir
      if (m.defaults && !m.defaults.hasEnvWallet) {
        const opt = document.querySelector('#f-wallet option[value="env"]')
        opt.disabled = true
        opt.textContent = "server wallet (not configured)"
      }
      render()
    } else if (m.type === "sessions") {
      sessions = m.sessions
      render()
    }
  }
  ws.onclose = () => {
    $("conn").classList.add("off")
    setTimeout(connect, (retryMs = Math.min(5000, retryMs * 1.5)))
  }
  ws.onerror = () => ws.close()
}

// ---------- render ----------
const RUNNING = new Set(["running", "starting", "reconciling", "funding", "uploading"])

function render() {
  const live = sessions.filter((s) => s.live).length
  $("head-live").hidden = false
  $("head-live").textContent = `${sessions.length} sessions · ${live} live`
  $("empty").hidden = sessions.length > 0
  $("sessions-table").style.display = sessions.length ? "" : "none"

  $("sessions-body").innerHTML = sessions
    .map((s) => {
      const running = RUNNING.has(s.status)
      const pct = s.planned ? Math.min(100, (100 * s.uploaded) / s.planned) : 0
      const failPct = s.planned ? Math.min(100 - pct, (100 * s.failed) / s.planned) : 0
      return `<tr data-id="${s.id}">
        <td><span class="pill mono ${s.status}">${s.status}</span></td>
        <td><a href="/s/${s.id}">${s.id}</a></td>
        <td title="${text(s.dir)}">${text(s.app)} <span class="dim2">/ ${text(s.runId)}</span></td>
        <td>
          <div class="mini-wrap">
            <div class="mini-progress"><i style="width:${pct}%"></i><b style="width:${failPct}%"></b></div>
            <span>${fmtInt(s.uploaded)}/${fmtInt(s.planned) === "—" ? "?" : fmtInt(s.planned)}${s.failed ? ` · ${s.failed}✗` : ""}</span>
          </div>
        </td>
        <td class="r">${fmtBytes(s.bytes)}</td>
        <td title="${text(s.wallet ?? "")}">${shortHex(s.wallet)}${s.walletMode === "fresh" ? " <span class='dim2'>fresh</span>" : ""}</td>
        <td>${rel(s.startedAt ?? s.createdAt)}</td>
        <td class="r">${dur(s.startedAt, s.finishedAt)}</td>
        <td class="actions-cell">
          <a class="btn-link" href="/s/${s.id}">view</a>
          ${running ? `<button data-act="stop">stop</button>` : `<button data-act="delete" class="danger">delete</button>`}
        </td>
      </tr>`
    })
    .join("")
}

$("sessions-body").addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-act]")
  if (!btn) return
  const id = btn.closest("tr").dataset.id
  const act = btn.dataset.act
  btn.disabled = true
  try {
    if (act === "stop") {
      await authFetch(`/api/sessions/${id}/stop`, { method: "POST" })
    } else if (act === "delete") {
      if (!confirm(`Delete session ${id} and all its statistics? This cannot be undone.`)) return
      const res = await authFetch(`/api/sessions/${id}`, { method: "DELETE" })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) alert(body.error ?? `delete failed (${res.status})`)
    }
  } finally {
    btn.disabled = false
  }
})

// ---------- new session ----------
$("form").addEventListener("submit", async (e) => {
  e.preventDefault()
  const msg = $("form-msg")
  msg.textContent = ""
  const f = new FormData(e.target)
  const body = {
    dir: f.get("dir")?.trim(),
    app: f.get("app")?.trim(),
    batch: Number(f.get("batch")) || 10,
    limit: f.get("limit") ? Number(f.get("limit")) : null,
    expiresDays: Number(f.get("expiresDays")) || 30,
    walletMode: f.get("walletMode"),
  }
  $("btn-start").disabled = true
  try {
    const res = await authFetch("/api/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })
    const data = await res.json().catch(() => ({}))
    if (res.ok && data.id) {
      location.href = `/s/${data.id}`
    } else {
      msg.textContent = `✗ ${data.error ?? `failed (${res.status})`}`
    }
  } finally {
    $("btn-start").disabled = false
  }
})

setInterval(render, 5000) // relative times + running durations tick
connect()
