// Fund the test account headlessly via the Atlas faucet (solves the PoW locally).
// The faucet drips 1 GLM per claim with a 60s per-address cooldown.
//
// Usage:
//   npm run fund                 # one claim (+1 GLM)
//   npm run fund -- --times 5    # five claims (waits out the cooldown between)
//   npm run fund -- --target 10  # claim until balance >= 10 GLM

import { parseArgs } from "node:util"
import { formatEther, parseEther } from "@atlas-chain/sdk"
import { makeWalletClient, accountAddress } from "../src/lib/atlas.js"
import { claimWithCooldown } from "../src/lib/faucet.js"

const { values } = parseArgs({
  options: { times: { type: "string" }, target: { type: "string" } },
})

const address = accountAddress()
const client = makeWalletClient()
const balance = () => client.getBalance({ address })

const targetWei = values.target ? parseEther(values.target) : null
const times = values.times ? Math.max(1, Number(values.times)) : 1

console.log(`address ${address}`)
console.log(`balance ${formatEther(await balance())} GLM`)
if (targetWei) console.log(`target  ${values.target} GLM`)
else console.log(`claims  ${times} × 1 GLM`)

let claimed = 0
for (;;) {
  const bal = await balance()
  if (targetWei ? bal >= targetWei : claimed >= times) break

  process.stdout.write(`  claim #${claimed + 1} — solving PoW…`)
  const res = await claimWithCooldown(address, {
    onWait: (s) => process.stdout.write(` cooldown ${s}s…`),
  })
  claimed++
  // let the drip land
  let landed = false
  for (let i = 0; i < 30 && !landed; i++) {
    await new Promise((r) => setTimeout(r, 1000))
    landed = (await balance()) > bal
  }
  console.log(` +1 GLM (tx ${res.txHash.slice(0, 12)}…)  balance ${formatEther(await balance())} GLM`)
}

console.log(`done: ${claimed} claim(s), balance ${formatEther(await balance())} GLM`)
