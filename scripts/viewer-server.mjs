// Web viewer for images stored on Atlas.
//
// A tiny dependency-free HTTP server: the chain is queried for image metadata
// (by attribute) via the public client, and the bytes are streamed from the
// public payload provider. Open http://localhost:8787 and browse the gallery.
//
// Usage: node scripts/viewer-server.mjs [--port 8787] [--app atlas-loadtest]

import http from "node:http"
import { parseArgs } from "node:util"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"
import { makePublicClient } from "../src/lib/atlas.js"
import { queryEntitiesRaw, fetchPayloadRaw } from "../src/lib/read.js"

const { values } = parseArgs({
  options: {
    port: { type: "string", default: process.env.PORT ?? "8787" },
    app: { type: "string", default: process.env.APP ?? "atlas-loadtest" },
  },
})
const PORT = Number(values.port)
const DEFAULT_APP = values.app
const reader = makePublicClient()

// branding assets (favicon + social share card)
const ASSETS = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "assets")
const OG_PNG = readFileSync(join(ASSETS, "og.png"))
const FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#0d1117"/><rect x="2" y="2" width="60" height="60" rx="12" fill="none" stroke="#30363d" stroke-width="2"/><text x="32" y="35" font-size="38" text-anchor="middle" dominant-baseline="central">🐶</text></svg>`

const attr = (e, k) => e.attributes.find((a) => a.key === k)?.value

async function apiImages(url, res) {
  const app = url.searchParams.get("app") || ""
  const run = url.searchParams.get("run") || ""
  const limit = Math.min(200, Number(url.searchParams.get("limit") || 60))
  const cursor = url.searchParams.get("cursor") || undefined

  const filters = {}
  if (app) filters.app = app
  if (run) filters.run = run

  // newest first when we have the numeric seq from the load test
  const orderBy = app ? [{ name: "seq", type: "numeric", desc: true }] : undefined

  const { entities, cursor: next, blockNumber } = await queryEntitiesRaw(reader, {
    filters,
    limit,
    cursor,
    orderBy,
  })

  const images = entities
    .filter((e) => e.payloadRef)
    .map((e) => ({
      key: e.key,
      payloadId: e.payloadRef.id,
      contentType: e.contentType ?? e.payloadRef.contentType ?? "image/png",
      sizeBytes: e.payloadRef.sizeBytes,
      owner: e.owner,
      name: attr(e, "name"),
      app: attr(e, "app"),
      run: attr(e, "run"),
      seq: attr(e, "seq"),
    }))

  json(res, { images, cursor: next, blockNumber, count: images.length })
}

async function imgProxy(id, res) {
  try {
    const bytes = await fetchPayloadRaw(id)
    res.writeHead(200, {
      "content-type": "image/png",
      "cache-control": "public, max-age=86400",
    })
    res.end(Buffer.from(bytes))
  } catch (e) {
    res.writeHead(502, { "content-type": "text/plain" })
    res.end(`payload fetch failed: ${e.message}`)
  }
}

function json(res, obj, status = 200) {
  const body = JSON.stringify(obj)
  res.writeHead(status, { "content-type": "application/json" })
  res.end(body)
}

const SVG_HEAD = { "content-type": "image/svg+xml; charset=utf-8", "cache-control": "public, max-age=86400" }

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://localhost:${PORT}`)
    if (url.pathname === "/healthz") return json(res, { ok: true })
    if (url.pathname === "/") {
      // absolute base URL so og:image works on any host (localhost or Dokploy domain)
      const proto = (req.headers["x-forwarded-proto"] || "http").split(",")[0].trim()
      const host = req.headers["x-forwarded-host"] || req.headers.host || `localhost:${PORT}`
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" })
      return res.end(PAGE.replaceAll("__BASE__", `${proto}://${host}`))
    }
    if (url.pathname === "/og.png") {
      res.writeHead(200, { "content-type": "image/png", "cache-control": "public, max-age=86400" })
      return res.end(OG_PNG)
    }
    if (url.pathname === "/favicon.svg" || url.pathname === "/favicon.ico") {
      res.writeHead(200, SVG_HEAD)
      return res.end(FAVICON_SVG)
    }
    if (url.pathname === "/api/images") return await apiImages(url, res)
    if (url.pathname.startsWith("/img/")) return await imgProxy(url.pathname.slice(5), res)
    res.writeHead(404, { "content-type": "text/plain" })
    res.end("not found")
  } catch (e) {
    json(res, { error: e.message }, 500)
  }
})

server.listen(PORT, () => {
  console.log(`Atlas image viewer → http://localhost:${PORT}`)
  console.log(`  default app filter: "${DEFAULT_APP}"  (change it in the UI)`)
})

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Atlas image viewer</title>
<meta name="description" content="Browse images stored on-chain on the Atlas network." />
<link rel="icon" type="image/svg+xml" href="/favicon.svg" />
<meta property="og:type" content="website" />
<meta property="og:title" content="🐶 Atlas image viewer" />
<meta property="og:description" content="Browse images stored on-chain on the Atlas network — queried live, streamed from the payload provider." />
<meta property="og:url" content="__BASE__/" />
<meta property="og:image" content="__BASE__/og.png" />
<meta property="og:image:width" content="1200" />
<meta property="og:image:height" content="630" />
<meta name="twitter:card" content="summary_large_image" />
<meta name="twitter:title" content="🐶 Atlas image viewer" />
<meta name="twitter:description" content="Browse images stored on-chain on the Atlas network." />
<meta name="twitter:image" content="__BASE__/og.png" />
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 14px/1.4 system-ui, sans-serif; background: #0d1117; color: #c9d1d9; }
  header { padding: 12px 16px; background: #161b22; border-bottom: 1px solid #30363d; position: sticky; top: 0; display: flex; gap: 8px; align-items: center; flex-wrap: wrap; z-index: 10; }
  header h1 { font-size: 15px; margin: 0 12px 0 0; font-weight: 600; }
  input { background: #0d1117; color: #c9d1d9; border: 1px solid #30363d; border-radius: 6px; padding: 6px 8px; }
  button { background: #238636; color: #fff; border: 0; border-radius: 6px; padding: 6px 12px; cursor: pointer; }
  button.secondary { background: #21262d; border: 1px solid #30363d; }
  button:disabled { opacity: .5; cursor: default; }
  #status { color: #8b949e; margin-left: auto; }
  #grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 10px; padding: 16px; }
  .card { background: #161b22; border: 1px solid #30363d; border-radius: 8px; overflow: hidden; cursor: pointer; transition: border-color .1s; }
  .card:hover { border-color: #58a6ff; }
  .card img { width: 100%; aspect-ratio: 1; object-fit: cover; display: block; background: #0d1117; }
  .card .meta { padding: 6px 8px; font-size: 11px; color: #8b949e; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  #sentinel { height: 1px; }
  #end { text-align: center; color: #8b949e; padding: 24px; }
  dialog { background: #161b22; color: #c9d1d9; border: 1px solid #30363d; border-radius: 10px; max-width: 92vw; max-height: 92vh; padding: 0; }
  dialog::backdrop { background: rgba(0,0,0,.7); }
  dialog img { max-width: 70vw; max-height: 70vh; display: block; }
  .modal-body { display: flex; gap: 16px; padding: 16px; flex-wrap: wrap; }
  .modal-meta { font-size: 12px; max-width: 360px; word-break: break-all; }
  .modal-meta div { margin-bottom: 6px; }
  .modal-meta a { color: #58a6ff; }
  .k { color: #8b949e; }
</style>
</head>
<body>
<header>
  <h1>🐶 Atlas image viewer</h1>
  <label class="k">app</label><input id="app" value="__APP__" size="16" />
  <label class="k">run</label><input id="run" placeholder="(optional)" size="20" />
  <label class="k">limit</label><input id="limit" value="60" size="3" />
  <button id="load">Load</button>
  <span id="status"></span>
</header>
<div id="grid"></div>
<div id="sentinel"></div>
<div id="end"></div>
<dialog id="modal"><div class="modal-body">
  <img id="modal-img" />
  <div class="modal-meta" id="modal-meta"></div>
</div></dialog>
<script>
const grid = document.getElementById('grid')
const statusEl = document.getElementById('status')
const endEl = document.getElementById('end')
const sentinel = document.getElementById('sentinel')
const modal = document.getElementById('modal')
const SCANNER = 'https://scanner.atlas.arkiv-global.net/entity/'
let cursor = null
let loading = false
let done = false

function qs() {
  const app = document.getElementById('app').value.trim()
  const run = document.getElementById('run').value.trim()
  const limit = document.getElementById('limit').value.trim() || '60'
  const p = new URLSearchParams({ app, limit })
  if (run) p.set('run', run)
  return p
}

const nearViewport = (el) => el.getBoundingClientRect().top < innerHeight + 600

async function load(reset) {
  if (loading) return
  if (reset) { grid.innerHTML = ''; cursor = null; done = false; endEl.textContent = '' }
  if (done) return
  loading = true
  statusEl.textContent = 'loading…'
  const p = qs()
  if (cursor) p.set('cursor', cursor)
  let data
  try { data = await (await fetch('/api/images?' + p)).json() }
  catch (e) { statusEl.textContent = 'error: ' + e.message; loading = false; return }
  if (data.error) { statusEl.textContent = 'error: ' + data.error; loading = false; return }
  for (const img of data.images) addCard(img)
  cursor = data.cursor
  if (!data.images.length || !cursor) {
    done = true
    endEl.textContent = grid.children.length ? '— end —' : 'no images for this filter'
  }
  statusEl.textContent = grid.children.length + ' images (block ' + (parseInt(data.blockNumber, 16) || '?') + ')'
  loading = false
  // keep filling while the page is too short to scroll (sentinel still in view)
  if (!done && nearViewport(sentinel)) load(false)
}

function addCard(img) {
  const card = document.createElement('div')
  card.className = 'card'
  card.innerHTML =
    '<img loading="lazy" src="/img/' + img.payloadId + '" />' +
    '<div class="meta">' + (img.name || img.key.slice(0,10)) + (img.seq!=null?(' · #'+img.seq):'') + '</div>'
  card.onclick = () => openModal(img)
  grid.appendChild(card)
}

function openModal(img) {
  document.getElementById('modal-img').src = '/img/' + img.payloadId
  document.getElementById('modal-meta').innerHTML =
    '<div><span class="k">name</span> ' + (img.name||'—') + '</div>' +
    '<div><span class="k">app</span> ' + (img.app||'—') + ' &nbsp; <span class="k">run</span> ' + (img.run||'—') + ' &nbsp; <span class="k">seq</span> ' + (img.seq??'—') + '</div>' +
    '<div><span class="k">size</span> ' + (img.sizeBytes||'?') + ' bytes &nbsp; <span class="k">type</span> ' + img.contentType + '</div>' +
    '<div><span class="k">owner</span> ' + (img.owner||'—') + '</div>' +
    '<div><span class="k">entity</span> ' + img.key + '</div>' +
    '<div><span class="k">payload id</span> ' + img.payloadId + '</div>' +
    '<div><a href="' + SCANNER + img.key + '" target="_blank">open in scanner ↗</a></div>'
  modal.showModal()
}
modal.onclick = (e) => { if (e.target === modal) modal.close() }

document.getElementById('load').onclick = () => load(true)
for (const el of document.querySelectorAll('header input'))
  el.addEventListener('keydown', (e) => { if (e.key === 'Enter') load(true) })

// seamless infinite scroll: auto-load the next page as the sentinel nears view
new IntersectionObserver(
  (entries) => { if (entries.some((e) => e.isIntersecting)) load(false) },
  { rootMargin: '600px' },
).observe(sentinel)

load(true)
</script>
</body>
</html>`.replace("__APP__", DEFAULT_APP)
