// Headless Atlas faucet client: fetches a proof-of-work challenge, solves it
// across all CPU cores, and submits the claim — no browser needed.
//
// Wire spec mirrored byte-for-byte from atlas-faucet (src/pow.rs, src/util.rs):
//   per-puzzle preimage = sha256( salt[16] || address[20] || indexLE32 || nonceLE32 )
//   a puzzle is solved when the digest has >= `bits` leading zero bits (MSB-first).
//   the challenge asks for `puzzles` independent sub-puzzles; one nonce each.

import { createHash } from "node:crypto"
import os from "node:os"
import { Worker } from "node:worker_threads"
import { FAUCET_URL } from "./atlas.js"

const hexBody = (s) => (s.startsWith("0x") || s.startsWith("0X") ? s.slice(2) : s)

// Reference single-puzzle hash — kept so tests can pin JS<->Rust parity.
export function puzzleHash(saltBuf, addrBuf, index, nonce) {
  const pre = Buffer.alloc(44)
  saltBuf.copy(pre, 0)
  addrBuf.copy(pre, 16)
  pre.writeUInt32LE(index >>> 0, 36)
  pre.writeUInt32LE(nonce >>> 0, 40)
  return createHash("sha256").update(pre).digest()
}

export function leadingZeroBits(digest) {
  let count = 0
  for (let i = 0; i < digest.length; i++) {
    if (digest[i] === 0) count += 8
    else return count + (Math.clz32(digest[i]) - 24)
  }
  return count
}

// Worker source (CommonJS — `new Worker(code, { eval: true })` runs it as CJS).
const WORKER_SRC = `
const { parentPort, workerData } = require("worker_threads")
const { createHash } = require("crypto")
const salt = Buffer.from(workerData.saltHex, "hex")
const addr = Buffer.from(workerData.addrHex, "hex")
const { bits, start, end } = workerData
const pre = Buffer.alloc(44)
salt.copy(pre, 0)
addr.copy(pre, 16)
const out = []
for (let index = start; index < end; index++) {
  pre.writeUInt32LE(index >>> 0, 36)
  let nonce = 0
  for (;;) {
    pre.writeUInt32LE(nonce >>> 0, 40)
    const h = createHash("sha256").update(pre).digest()
    let lz = 0
    for (let i = 0; i < h.length; i++) { if (h[i] === 0) lz += 8; else { lz += Math.clz32(h[i]) - 24; break } }
    if (lz >= bits) { out.push(nonce); break }
    nonce++
  }
}
parentPort.postMessage({ start, nonces: out })
`

/**
 * Solve every sub-puzzle of a challenge, returning the nonce array (length =
 * challenge.puzzles), parallelised across CPU cores.
 */
export async function solveChallenge(challenge, { onProgress } = {}) {
  const saltHex = hexBody(challenge.salt)
  const addrHex = hexBody(challenge.address)
  const { bits, puzzles } = challenge

  const workerCount = Math.max(1, Math.min(os.cpus().length, puzzles))
  const chunk = Math.ceil(puzzles / workerCount)
  const nonces = new Array(puzzles)
  let done = 0

  const jobs = []
  for (let w = 0; w < workerCount; w++) {
    const start = w * chunk
    const end = Math.min(start + chunk, puzzles)
    if (start >= end) break
    jobs.push(
      new Promise((resolve, reject) => {
        const worker = new Worker(WORKER_SRC, {
          eval: true,
          workerData: { saltHex, addrHex, bits, start, end },
        })
        worker.once("message", (msg) => {
          for (let i = 0; i < msg.nonces.length; i++) nonces[msg.start + i] = msg.nonces[i]
          done += msg.nonces.length
          onProgress?.(done, puzzles)
          worker.terminate().then(resolve, reject)
        })
        worker.once("error", reject)
      }),
    )
  }

  await Promise.all(jobs)
  return nonces
}

export async function fetchChallenge(address) {
  const res = await fetch(`${FAUCET_URL}/api/challenge?address=${address}`)
  const body = await res.json()
  if (!res.ok || !body.ok) {
    const code = body?.error?.code ?? res.status
    throw new Error(`faucet challenge failed (${code}): ${body?.error?.message ?? "unknown"}`)
  }
  return body.challenge
}

export async function submitClaim(challenge, nonces) {
  const res = await fetch(`${FAUCET_URL}/api/claim`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ challenge, nonces }),
  })
  const body = await res.json()
  if (!res.ok || !body.ok) {
    const code = body?.error?.code ?? res.status
    throw new Error(`faucet claim failed (${code}): ${body?.error?.message ?? "unknown"}`)
  }
  return body
}

/** End-to-end: request a challenge, solve it, claim the drip. */
export async function fundAddress(address, { onProgress } = {}) {
  const challenge = await fetchChallenge(address)
  const nonces = await solveChallenge(challenge, { onProgress })
  return submitClaim(challenge, nonces)
}
