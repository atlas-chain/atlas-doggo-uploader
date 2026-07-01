// Basic functional tests for the Atlas hello-world foundation.
//
//   node --test tests/            # offline tests (no network)
//   ATLAS_E2E=1 node --test tests/ # also runs the live upload/download round-trip
//
// The offline tests pin the faucet proof-of-work to be byte-identical with the
// Rust faucet (atlas-faucet/src/pow.rs browser_parity_vector), so we never burn
// a real challenge to discover a wire-format bug.

import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync, existsSync } from "node:fs"
import { puzzleHash, leadingZeroBits, solveChallenge } from "../src/lib/faucet.js"
import { makePng, makePngOfApproxSize } from "../src/lib/png.js"
import { pickDog, listDogNames, DOGS_DIR } from "../src/lib/images.js"

const PNG_MAGIC = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])

test("leadingZeroBits matches the Rust spec vectors", () => {
  assert.equal(leadingZeroBits(Buffer.from([0xff])), 0)
  assert.equal(leadingZeroBits(Buffer.from([0x00, 0xff])), 8)
  assert.equal(leadingZeroBits(Buffer.from([0x00, 0x00, 0x80])), 16)
  assert.equal(leadingZeroBits(Buffer.from([0x0f])), 4)
  assert.equal(leadingZeroBits(Buffer.from([0x00, 0x01])), 15)
  assert.equal(leadingZeroBits(Buffer.from([0x00, 0x00, 0x00, 0x00])), 32)
})

test("puzzleHash is byte-identical with the faucet (browser parity vector)", () => {
  const salt = Buffer.from(Array.from({ length: 16 }, (_, i) => i))
  const addr = Buffer.from(Array.from({ length: 20 }, (_, i) => i + 0x10))
  const hash = puzzleHash(salt, addr, 3, 123456)
  assert.equal(
    hash.toString("hex"),
    "cb61395fc2a014e274c4e5af81101378b3d979e9052582fb9746cd6e900582c1",
  )
})

test("solveChallenge produces nonces that satisfy the difficulty", async () => {
  const saltHex = "000102030405060708090a0b0c0d0e0f"
  const addrHex = "101112131415161718191a1b1c1d1e1f20212223"
  const challenge = { salt: `0x${saltHex}`, address: `0x${addrHex}`, bits: 10, puzzles: 8 }
  const nonces = await solveChallenge(challenge)
  assert.equal(nonces.length, 8)
  const salt = Buffer.from(saltHex, "hex")
  const addr = Buffer.from(addrHex, "hex")
  nonces.forEach((nonce, i) => {
    assert.ok(leadingZeroBits(puzzleHash(salt, addr, i, nonce)) >= 10, `puzzle ${i} unsolved`)
  })
})

test("makePng emits a valid PNG that round-trips through Buffer", () => {
  const png = makePng({ width: 32, height: 32, seed: 7 })
  assert.ok(Buffer.from(png.subarray(0, 8)).equals(PNG_MAGIC))
  const approx = makePngOfApproxSize(100_000)
  assert.ok(Buffer.from(approx.subarray(0, 8)).equals(PNG_MAGIC))
  // noisy 100KB image should be in the right ballpark
  assert.ok(approx.length > 80_000 && approx.length < 120_000, `size ${approx.length}`)
})

test(
  "dog dataset is present and files are real PNGs",
  { skip: existsSync(DOGS_DIR) ? false : "dog dataset not present (dropped in locally, not in repo)" },
  () => {
    const names = listDogNames(5)
    assert.ok(names.length > 0, "no dog images found")
    const bytes = readFileSync(pickDog())
    assert.ok(bytes.subarray(0, 8).equals(PNG_MAGIC), "dog file is not a PNG")
  }
)

test(
  "live: upload + download round-trip on Atlas",
  { skip: process.env.ATLAS_E2E ? false : "set ATLAS_E2E=1 to run" },
  async () => {
    const { createHash } = await import("node:crypto")
    const { ExpirationTime } = await import("@atlas-chain/sdk/utils")
    const { makeWalletClient, makePublicClient, accountAddress } = await import(
      "../src/lib/atlas.js"
    )
    const sha = (b) => createHash("sha256").update(b).digest("hex")

    const wallet = makeWalletClient()
    const reader = makePublicClient()
    const balance = await wallet.getBalance({ address: accountAddress() })
    assert.ok(balance > 0n, "account is unfunded — run `npm run fund` first")

    const bytes = new Uint8Array(readFileSync(pickDog()))
    const { entityKey } = await wallet.createEntity({
      payload: bytes,
      contentType: "image/png",
      attributes: [{ key: "app", value: "atlas-smoke-test" }],
      expiresIn: ExpirationTime.fromDays(1),
    })
    const entity = await reader.getEntity(entityKey, { hydratePayload: true })
    assert.equal(sha(bytes), sha(entity.payload), "round-trip checksum mismatch")
  },
)
