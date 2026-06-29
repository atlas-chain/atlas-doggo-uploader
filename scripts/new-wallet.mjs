// Generate a fresh, clean Atlas wallet for a dedicated upload run and write it
// to .env (backing up any existing .env to .env.bak). Print the address + key
// so it can also be set as ATLAS_PRIVATE_KEY on a remote server.
//
// Usage: npm run new-wallet

import { writeFileSync, existsSync, copyFileSync, readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"
import { generatePrivateKey, privateKeyToAccount } from "@atlas-chain/sdk/accounts"
import { DEFAULT_BEARER_KEY } from "../src/lib/atlas.js"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const ENV_PATH = join(ROOT, ".env")

if (existsSync(ENV_PATH)) {
  copyFileSync(ENV_PATH, `${ENV_PATH}.bak`)
  const prev = /ATLAS_PRIVATE_KEY=(\S+)/.exec(readFileSync(ENV_PATH, "utf8"))
  if (prev) console.log(`backed up previous .env (was ${privateKeyToAccount(prev[1]).address}) -> .env.bak`)
}

const privateKey = generatePrivateKey()
const { address } = privateKeyToAccount(privateKey)

writeFileSync(
  ENV_PATH,
  `# Atlas upload wallet (throwaway testnet)\n` +
    `ATLAS_PRIVATE_KEY=${privateKey}\n` +
    `ATLAS_PAYLOAD_BEARER_KEY=${DEFAULT_BEARER_KEY}\n`,
  { mode: 0o600 },
)

console.log("\nNew clean wallet:")
console.log("  address     :", address)
console.log("  private key :", privateKey)
console.log("  saved to    :", ENV_PATH)
console.log("\nTo run on a server, set this env var instead of shipping .env:")
console.log(`  export ATLAS_PRIVATE_KEY=${privateKey}`)
console.log("\nNext: npm run fund -- --target 10    then    npm run upload-dir -- --dir <path>")
