// The always-on uploader service: session list at /, live/historical session
// dashboards at /s/<id>, WebSocket fan-out per session plus a "list" topic for
// the home page. Viewing is public; starting, stopping and deleting sessions
// requires the admin token (ATLAS_ADMIN_TOKEN, or a random one printed at
// boot) as an  Authorization: Bearer <token>  header.

import { join } from "node:path"
import { createHash, timingSafeEqual, randomBytes } from "node:crypto"
import { HttpError } from "./sessions.js"

const PUBLIC_DIR = join(import.meta.dir, "..", "dashboard", "public")

const STATIC = {
  "/": { file: "home.html", type: "text/html; charset=utf-8" },
  "/home.js": { file: "home.js", type: "text/javascript; charset=utf-8" },
  "/app.js": { file: "app.js", type: "text/javascript; charset=utf-8" },
  "/style.css": { file: "style.css", type: "text/css; charset=utf-8" },
}

const SESSION_PAGE = { file: "index.html", type: "text/html; charset=utf-8" }

const FAVICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="10" fill="#111111"/><text x="32" y="36" font-size="34" text-anchor="middle" dominant-baseline="central">🐶</text></svg>`

const sha = (s) => createHash("sha256").update(s).digest()

export function startService({ manager, port = 3000, adminToken, defaultDir, hasEnvWallet }) {
  const token = adminToken || randomBytes(24).toString("base64url")

  const authed = (req) => {
    const m = /^Bearer (.+)$/.exec(req.headers.get("authorization") ?? "")
    return !!m && timingSafeEqual(sha(m[1]), sha(token))
  }

  const json = (obj, status = 200) =>
    new Response(JSON.stringify(obj), {
      status,
      headers: { "content-type": "application/json" },
    })

  const guard = (req, fn) => {
    if (!authed(req)) return json({ error: "admin token required" }, 401)
    try {
      return json({ ok: true, ...fn() })
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message }, e.status)
      return json({ error: e.message ?? String(e) }, 500)
    }
  }

  const server = Bun.serve({
    port,
    hostname: "0.0.0.0",
    fetch(req, srv) {
      const url = new URL(req.url)
      const path = url.pathname

      if (path === "/ws") {
        const sid = url.searchParams.get("s")
        if (srv.upgrade(req, { data: { sid } })) return undefined
        return new Response("websocket upgrade required", { status: 426 })
      }
      if (path === "/healthz") return json({ ok: true, live: manager.liveCount() })
      if (path === "/favicon.svg" || path === "/favicon.ico")
        return new Response(FAVICON, {
          headers: { "content-type": "image/svg+xml", "cache-control": "public, max-age=86400" },
        })

      // ---- sessions API ----
      if (path === "/api/sessions" && req.method === "GET")
        return json({ sessions: manager.list(), serverNow: Date.now() })
      if (path === "/api/sessions" && req.method === "POST") {
        if (!authed(req)) return json({ error: "admin token required" }, 401)
        return req
          .json()
          .catch(() => ({}))
          .then((body) => {
            try {
              return json({ ok: true, ...manager.createSession(body) }, 201)
            } catch (e) {
              if (e instanceof HttpError) return json({ error: e.message }, e.status)
              return json({ error: e.message ?? String(e) }, 500)
            }
          })
      }
      const m = /^\/api\/sessions\/(s[0-9a-f]{8})(\/stop)?$/.exec(path)
      if (m) {
        const [, sid, action] = m
        if (req.method === "GET" && !action) {
          const snap = manager.snapshot(sid)
          return snap ? json(snap) : json({ error: "no such session" }, 404)
        }
        if (req.method === "POST" && action === "/stop") return guard(req, () => manager.stop(sid))
        if (req.method === "DELETE" && !action) return guard(req, () => manager.delete(sid))
      }

      // ---- pages + assets ----
      const entry = /^\/s\/s[0-9a-f]{8}$/.test(path) ? SESSION_PAGE : STATIC[path]
      if (entry && req.method === "GET")
        return new Response(Bun.file(join(PUBLIC_DIR, entry.file)), {
          headers: { "content-type": entry.type, "cache-control": "no-cache" },
        })
      return new Response("not found", { status: 404 })
    },
    websocket: {
      open(ws) {
        const { sid } = ws.data ?? {}
        if (sid) {
          ws.subscribe(`s:${sid}`)
          const state = manager.snapshot(sid)
          ws.send(JSON.stringify({ type: "hello", state, serverNow: Date.now() }))
        } else {
          ws.subscribe("list")
          ws.send(
            JSON.stringify({
              type: "hello-list",
              sessions: manager.list(),
              serverNow: Date.now(),
              defaults: { dir: defaultDir, hasEnvWallet },
            }),
          )
        }
      },
      message() {},
    },
  })

  manager.setPublish((topic, payload) => {
    try {
      server.publish(topic, payload)
    } catch {
      /* never let a slow client hurt the uploads */
    }
  })

  return { server, url: `http://localhost:${server.port}`, token }
}
