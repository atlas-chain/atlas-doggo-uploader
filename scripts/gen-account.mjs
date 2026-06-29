// Generate a throwaway Atlas test account and persist it to .env.
// Usage: npm run account   (add --force to overwrite an existing key)

import { writeFileSync, readFileSync, existsSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"
import { generatePrivateKey, privateKeyToAccount } from "@atlas-chain/sdk/accounts"
import { DEFAULT_BEARER_KEY } from "../src/lib/atlas.js"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const ENV_PATH = join(ROOT, ".env")
const force = process.argv.includes("--force")

if (existsSync(ENV_PATH) && /ATLAS_PRIVATE_KEY=/.test(readFileSync(ENV_PATH, "utf8")) && !force) {
  console.error(".env already has ATLAS_PRIVATE_KEY. Re-run with --force to overwrite.")
  process.exit(1)
}

const privateKey = generatePrivateKey()
const { address } = privateKeyToAccount(privateKey)

writeFileSync(
  ENV_PATH,
  `# Atlas test account (throwaway — testnet only)\n` +
    `ATLAS_PRIVATE_KEY=${privateKey}\n` +
    `ATLAS_PAYLOAD_BEARER_KEY=${DEFAULT_BEARER_KEY}\n`,
  { mode: 0o600 },
)

console.log("Generated Atlas test account")
console.log("  address :", address)
console.log("  saved to:", ENV_PATH)
console.log("\nNext: npm run fund")
