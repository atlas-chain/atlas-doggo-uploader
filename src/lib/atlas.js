// Shared Atlas configuration + client factories.
// Reused by the hello-world, the uploader, and the viewer apps.

import { readFileSync, existsSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"
import { createWalletClient, createPublicClient, http } from "@atlas-chain/sdk"
import { privateKeyToAccount } from "@atlas-chain/sdk/accounts"
import { atlas } from "@atlas-chain/sdk/chains"

// --- Live Atlas endpoints (the bundled SDK URL is overridden on purpose) ---
export const RPC_URL = "https://rpc.atlas.arkiv-global.net/"
export const PAYLOAD_URL = "https://payload.atlas.arkiv-global.net"
export const FAUCET_URL = "https://faucet.atlas.arkiv-global.net"
export const SCANNER_URL = "https://scanner.atlas.arkiv-global.net"
export const NAMESPACE = "arkiv.entities"
// Current public sandbox ingress key for the payload provider's upload endpoint.
export const DEFAULT_BEARER_KEY = "atlas-signer-pub-token"
export const CHAIN = atlas
// viem polls every `pollingInterval` ms for tx receipts; the 4000ms default
// quantizes waitForTransactionReceipt and ~doubles per-tx latency (blocks are
// 2s). 500ms detects inclusion promptly without hammering the RPC.
export const POLLING_INTERVAL = Number(process.env.ATLAS_POLLING_MS || 500)
// A batch uploads up to ~50 payloads in parallel. Bun's native fetch keeps a
// large keep-alive pool per host (256 by default, BUN_CONFIG_MAX_HTTP_REQUESTS
// to tune), so the dedicated undici dispatcher the Node version needed is gone.

// Project root = two levels up from src/lib/
const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..")
const ENV_PATH = join(PROJECT_ROOT, ".env")

/**
 * Minimal .env loader (no dotenv dependency). Existing process.env wins, so
 * `ATLAS_PRIVATE_KEY=... node script.mjs` still overrides the file.
 */
export function loadEnv() {
  if (!existsSync(ENV_PATH)) return
  for (const raw of readFileSync(ENV_PATH, "utf8").split("\n")) {
    const line = raw.trim()
    if (!line || line.startsWith("#")) continue
    const eq = line.indexOf("=")
    if (eq === -1) continue
    const key = line.slice(0, eq).trim()
    let val = line.slice(eq + 1).trim()
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1)
    }
    if (!(key in process.env)) process.env[key] = val
  }
}

export function getPrivateKey() {
  loadEnv()
  const key = process.env.ATLAS_PRIVATE_KEY
  if (!key) {
    throw new Error(
      "ATLAS_PRIVATE_KEY is not set. Run `npm run account` to generate one, then `npm run fund`.",
    )
  }
  return key.startsWith("0x") ? key : `0x${key}`
}

export function getBearerKey() {
  loadEnv()
  return process.env.ATLAS_PAYLOAD_BEARER_KEY || DEFAULT_BEARER_KEY
}

/** Wallet client: can write (createEntity) and read. Needs a funded key + bearer. */
export function makeWalletClient(privateKey = getPrivateKey()) {
  return createWalletClient({
    chain: CHAIN,
    transport: http(RPC_URL),
    pollingInterval: POLLING_INTERVAL,
    account: privateKeyToAccount(privateKey),
    payloadProvider: {
      url: PAYLOAD_URL,
      namespace: NAMESPACE,
      bearerKey: getBearerKey(),
    },
  })
}

/** Public client: read-only. Reads (incl. payload hydration) need no bearer. */
export function makePublicClient() {
  return createPublicClient({
    chain: CHAIN,
    transport: http(RPC_URL),
    pollingInterval: POLLING_INTERVAL,
    payloadProvider: {
      url: PAYLOAD_URL,
      namespace: NAMESPACE,
    },
  })
}

export const accountAddress = (privateKey = getPrivateKey()) =>
  privateKeyToAccount(privateKey).address
