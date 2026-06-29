// A pool of funded sender accounts. Concurrency on Atlas is per-account: the
// owner-nonce that derives each entity key is read from chain per create, so
// firing many creates from ONE account collides. Multiple accounts give us real
// parallel transaction streams. Accounts persist (out/bench-accounts.json) so
// reruns reuse already-funded keys.

import { writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs"
import { dirname } from "node:path"
import { formatEther } from "@atlas-chain/sdk"
import { generatePrivateKey, privateKeyToAccount } from "@atlas-chain/sdk/accounts"
import { makeWalletClient } from "./atlas.js"
import { fundAddress } from "./faucet.js"

/** Load up to `n` accounts from `file`, creating fresh ones as needed. */
export function loadOrCreatePool(n, file) {
  const pool = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : []
  while (pool.length < n) {
    const privateKey = generatePrivateKey()
    pool.push({ privateKey, address: privateKeyToAccount(privateKey).address })
  }
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(pool, null, 2), { mode: 0o600 })
  return pool.slice(0, n)
}

/** Ensure every account has a balance; fund the empty ones from the faucet (serially). */
export async function ensureFunded(pool, { log = () => {} } = {}) {
  for (const acct of pool) {
    const client = makeWalletClient(acct.privateKey)
    let balance = await client.getBalance({ address: acct.address })
    if (balance === 0n) {
      log(`funding ${acct.address} …`)
      await fundAddress(acct.address)
      for (let i = 0; i < 40 && balance === 0n; i++) {
        await new Promise((r) => setTimeout(r, 1500))
        balance = await client.getBalance({ address: acct.address })
      }
      if (balance === 0n) throw new Error(`failed to fund ${acct.address}`)
    }
    acct.balance = balance
    log(`ready   ${acct.address}  ${formatEther(balance)} GLM`)
  }
  return pool
}
