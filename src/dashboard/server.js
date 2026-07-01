// Live upload dashboard, served by Bun. One process runs both the upload
// engine and this server: every stats delta is fanned out to connected
// browsers over a WebSocket topic, and a client joining mid-run receives the
// full state snapshot first. After the run finishes the server lingers
// (default 60 min) so the dashboard, charts and summary stay reachable, then
// the process exits on its own.

import { join } from "node:path"

const PUBLIC_DIR = join(import.meta.dir, "public")

const STATIC = {
  "/": { file: "index.html", type: "text/html; charset=utf-8" },
  "/app.js": { file: "app.js", type: "text/javascript; charset=utf-8" },
  "/style.css": { file: "style.css", type: "text/css; charset=utf-8" },
}

const FAVICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="10" fill="#111111"/><text x="32" y="36" font-size="34" text-anchor="middle" dominant-baseline="central">🐶</text></svg>`

export function startDashboard({ stats, engine = null, port = 3000, lingerMin = 60, onExit }) {
  let lingerTimer = null
  let lingerUntil = null

  const exit = () => {
    stats.log("info", "linger window elapsed — dashboard shutting down")
    setTimeout(() => onExit?.(), 300) // let the last WS frames flush
  }

  const scheduleLinger = (minutes) => {
    if (lingerTimer) clearTimeout(lingerTimer)
    const ms = Math.max(0, minutes * 60_000)
    lingerUntil = Date.now() + ms
    stats.setLinger(lingerUntil, ms)
    lingerTimer = setTimeout(exit, ms)
    if (ms > 0)
      stats.log("info", `dashboard stays up for ${minutes} min (extend from the page or POST /api/linger)`)
  }

  const json = (obj, status = 200) =>
    new Response(JSON.stringify(obj), {
      status,
      headers: { "content-type": "application/json" },
    })

  const server = Bun.serve({
    port,
    hostname: "0.0.0.0",
    fetch(req, srv) {
      const url = new URL(req.url)
      const path = url.pathname

      if (path === "/ws") {
        if (srv.upgrade(req)) return undefined
        return new Response("websocket upgrade required", { status: 426 })
      }
      if (path === "/healthz") return json({ ok: true, status: stats.state.status })
      if (path === "/api/state") return json(stats.snapshot())
      if (path === "/api/linger" && req.method === "POST") {
        const min = Math.min(24 * 60, Math.max(0, Number(url.searchParams.get("min") ?? 60)))
        scheduleLinger(min)
        stats.log("info", `linger window set to ${min} min from now`)
        return json({ ok: true, lingerUntil })
      }
      if (path === "/api/stop" && req.method === "POST") {
        if (engine && !engine.stopping) engine.stop()
        return json({ ok: true, stopping: true })
      }
      if (path === "/favicon.svg" || path === "/favicon.ico") {
        return new Response(FAVICON, {
          headers: { "content-type": "image/svg+xml", "cache-control": "public, max-age=86400" },
        })
      }

      const entry = STATIC[path]
      if (entry) {
        return new Response(Bun.file(join(PUBLIC_DIR, entry.file)), {
          headers: { "content-type": entry.type, "cache-control": "no-cache" },
        })
      }
      return new Response("not found", { status: 404 })
    },
    websocket: {
      open(ws) {
        ws.subscribe("feed")
        ws.send(JSON.stringify({ type: "hello", state: stats.snapshot(), serverNow: Date.now() }))
      },
      message() {}, // clients only listen
    },
  })

  stats.onDelta((msg) => {
    try {
      server.publish("feed", JSON.stringify(msg))
    } catch {
      /* a slow client must never take down the uploader */
    }
  })

  return {
    server,
    url: `http://localhost:${server.port}`,
    port: server.port,
    /** Called once the run has finished: starts the linger countdown. */
    beginLinger: () => scheduleLinger(lingerMin),
    stop() {
      if (lingerTimer) clearTimeout(lingerTimer)
      server.stop(true)
    },
  }
}
