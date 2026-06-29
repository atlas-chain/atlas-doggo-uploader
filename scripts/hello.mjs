// Atlas hello-world: upload a real dog PNG, read it back, verify the round-trip,
// then query it back by attribute. Exercises the core SDK surface end-to-end.
//
// Usage: npm run hello [path/to/image.png]
//   - with no arg it uses a dog from ../Images/Dogs
//   - auto-funds the account from the faucet if its balance is zero

import { readFileSync, writeFileSync, mkdirSync } from "node:fs"
import { createHash } from "node:crypto"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"
import { formatEther } from "@atlas-chain/sdk"
import { ExpirationTime } from "@atlas-chain/sdk/utils"
import { makeWalletClient, makePublicClient, accountAddress, PAYLOAD_URL } from "../src/lib/atlas.js"
import { fundAddress } from "../src/lib/faucet.js"
import { pickDog } from "../src/lib/images.js"
import { queryEntitiesRaw } from "../src/lib/read.js"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const sha = (b) => createHash("sha256").update(b).digest("hex")

const imagePath = process.argv[2] ?? pickDog()
const bytes = new Uint8Array(readFileSync(imagePath))
console.log(`image      : ${imagePath} (${bytes.length} bytes)`)

const address = accountAddress()
const wallet = makeWalletClient()
const reader = makePublicClient()

console.log(`account    : ${address}`)
console.log(`chainId    : ${await wallet.getChainId()}`)

// --- ensure the account can pay gas ---
let balance = await wallet.getBalance({ address })
if (balance === 0n) {
  console.log("balance 0 — auto-funding from faucet…")
  const res = await fundAddress(address)
  console.log(`  faucet tx ${res.txHash}`)
  for (let i = 0; i < 40 && balance === 0n; i++) {
    await new Promise((r) => setTimeout(r, 1500))
    balance = await wallet.getBalance({ address })
  }
}
console.log(`balance    : ${formatEther(balance)} GLM`)
if (balance === 0n) throw new Error("account still unfunded — run `npm run fund` and retry")

// --- upload (payload goes off-chain to the provider; only a signed ref on-chain) ---
const t0 = Date.now()
const { entityKey, txHash } = await wallet.createEntity({
  payload: bytes,
  contentType: "image/png",
  attributes: [
    // keys must be lowercase and sorted ascending: app < kind
    { key: "app", value: "atlas-hello" },
    { key: "kind", value: "image" },
  ],
  expiresIn: ExpirationTime.fromDays(1),
})
console.log(`\nuploaded   : ${entityKey}`)
console.log(`  tx       : ${txHash}  (${((Date.now() - t0) / 1000).toFixed(2)}s)`)

// --- download (hydratePayload pulls + checksum-verifies the bytes) ---
const entity = await reader.getEntity(entityKey, { hydratePayload: true })
mkdirSync(join(ROOT, "out"), { recursive: true })
const outPath = join(ROOT, "out", "downloaded.png")
writeFileSync(outPath, entity.payload)
console.log(`\ndownloaded : ${outPath} (${entity.payload.length} bytes)`)
console.log(`  contentType: ${entity.contentType}`)
if (entity.payloadRef?.id) console.log(`  payload  : ${PAYLOAD_URL}/payloads/${entity.payloadRef.id}/raw`)

// --- verify round-trip ---
const ok = sha(bytes) === sha(entity.payload)
console.log(`\nround-trip : ${ok ? "✅ identical" : "❌ MISMATCH"}`)
if (!ok) process.exitCode = 1

// --- query it back by attribute (the read path the viewer app will use) ---
// NOTE: the SDK's QueryBuilder filters correctly but drops attributes on read
// (0.6.15 vs current RPC). We use a raw, attribute-aware query (src/lib/read.js).
const { entities } = await queryEntitiesRaw(reader, {
  filters: { app: "atlas-hello" },
  ownedBy: address,
  limit: 10,
})
const mine = entities.find((e) => e.key.toLowerCase() === entityKey.toLowerCase())
console.log(
  `query      : app="atlas-hello" ownedBy(me) -> ${entities.length} hit(s); contains our entity: ${mine ? "yes ✅" : "no ❌"}`,
)
if (mine) {
  console.log(`  attributes : ${mine.attributes.map((a) => `${a.key}=${a.value}`).join(", ")}`)
} else {
  process.exitCode = 1
}
