// Fund the test account headlessly via the Atlas faucet (solves the PoW locally).
// Usage: npm run fund

import { formatEther } from "@atlas-chain/sdk"
import { makeWalletClient, accountAddress } from "../src/lib/atlas.js"
import { fundAddress } from "../src/lib/faucet.js"

const address = accountAddress()
const client = makeWalletClient()

const before = await client.getBalance({ address })
console.log(`address ${address}`)
console.log(`balance ${formatEther(before)} GLM`)

if (before > 0n) {
  console.log("already funded — nothing to do.")
  process.exit(0)
}

let lastPct = -1
const onProgress = (done, total) => {
  const pct = Math.floor((done / total) * 100)
  if (pct >= lastPct + 10) {
    lastPct = pct
    process.stdout.write(`  solving proof-of-work… ${pct}%\r`)
  }
}

const t0 = Date.now()
console.log("requesting + solving faucet challenge…")
const res = await fundAddress(address, { onProgress })
console.log(
  `\nclaim ok in ${((Date.now() - t0) / 1000).toFixed(1)}s — tx ${res.txHash}, +${formatEther(BigInt(res.amountWei))} GLM`,
)

// Wait for the drip to land.
process.stdout.write("waiting for balance to update")
for (let i = 0; i < 40; i++) {
  await new Promise((r) => setTimeout(r, 1500))
  const bal = await client.getBalance({ address })
  if (bal > 0n) {
    console.log(`\nfunded: ${formatEther(bal)} GLM`)
    process.exit(0)
  }
  process.stdout.write(".")
}
console.error("\ntimed out waiting for balance — check the faucet/RPC and retry.")
process.exit(1)
