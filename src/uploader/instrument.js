// Instrumentation for the upload pipeline. The SDK's mutateEntities() hides the
// three commitment stages (payload upload → tx submit → receipt) inside one
// call, so we observe them from the outside instead of forking the SDK:
//
//   - payload uploads: the payload-provider `fetch` we inject sees every
//     POST /arkiv/payloads. The JSON body carries the entityKey, so each
//     request is attributed to a file (keys are derived from the wallet nonce
//     BEFORE the batch — see deriveNextEntityKeys).
//   - tx submit / receipt: a wrapped viem http transport sees
//     eth_sendRawTransaction (submit time + hash) and the first non-null
//     eth_getTransactionReceipt (confirmation + gas).
//
// Everything is reported through a tiny event bus that the stats aggregator,
// the console renderer and the dashboard server all subscribe to.

import {
  createWalletClient,
  http,
  keccak256,
  encodePacked,
  parseAbi,
} from "@atlas-chain/sdk"
import { privateKeyToAccount } from "@atlas-chain/sdk/accounts"
import {
  CHAIN,
  RPC_URL,
  PAYLOAD_URL,
  NAMESPACE,
  POLLING_INTERVAL,
  getBearerKey,
  getPrivateKey,
} from "../lib/atlas.js"

// The Arkiv registry contract (SDK src/consts.ts — not part of its public exports).
export const ARKIV_ADDRESS = "0x4400000000000000000000000000000000000044"
const NONCES_ABI = parseAbi(["function nonces(address owner) view returns (uint32)"])

/** Minimal event bus: on(type|'*', fn) / emit. Handlers must never throw. */
export function createBus() {
  const byType = new Map()
  const any = []
  return {
    on(type, fn) {
      if (type === "*") any.push(fn)
      else {
        if (!byType.has(type)) byType.set(type, [])
        byType.get(type).push(fn)
      }
      return this
    },
    emit(type, data = {}) {
      for (const fn of byType.get(type) ?? []) fn(data)
      for (const fn of any) fn(type, data)
    },
  }
}

// entityKey sits near the end of the payload POST body — scan backwards
// instead of JSON.parse-ing a multi-hundred-KB base64 envelope.
function extractEntityKey(body) {
  if (typeof body !== "string") return null
  const marker = '"entityKey":"'
  const i = body.lastIndexOf(marker)
  if (i === -1) return null
  const start = i + marker.length
  const end = body.indexOf('"', start)
  return end > start ? body.slice(start, end) : null
}

/** fetch for the payload provider that reports every upload to the bus. */
export function instrumentedFetch(bus) {
  return async (input, init = {}) => {
    const url = typeof input === "string" ? input : input.url
    if (!(init.method === "POST" && url.endsWith("/arkiv/payloads"))) return fetch(input, init)

    const body = init.body
    const wireBytes = typeof body === "string" ? new TextEncoder().encode(body).length : 0
    const entityKey = extractEntityKey(body)
    bus.emit("payload:start", { entityKey, wireBytes })
    const t0 = performance.now()
    try {
      const res = await fetch(input, init)
      const ms = Math.round(performance.now() - t0)
      if (res.ok) bus.emit("payload:done", { entityKey, wireBytes, ms })
      else bus.emit("payload:fail", { entityKey, wireBytes, ms, error: `HTTP ${res.status}` })
      return res
    } catch (e) {
      bus.emit("payload:fail", {
        entityKey,
        wireBytes,
        ms: Math.round(performance.now() - t0),
        error: e.message,
      })
      throw e
    }
  }
}

const hexToInt = (h) => (h == null ? null : Number(BigInt(h)))

/** viem http transport that reports tx submits, receipts and RPC latency. */
export function instrumentedHttp(url, bus) {
  const base = http(url)
  return (params) => {
    const transport = base(params)
    return {
      ...transport,
      async request(args, options) {
        const t0 = performance.now()
        try {
          const result = await transport.request(args, options)
          const ms = Math.round(performance.now() - t0)
          bus.emit("rpc", { method: args.method, ms, ok: true })
          if (args.method === "eth_sendRawTransaction") {
            bus.emit("tx:submitted", { txHash: result, ms })
          } else if (args.method === "eth_getTransactionReceipt" && result) {
            bus.emit("tx:receipt", {
              txHash: result.transactionHash,
              block: hexToInt(result.blockNumber),
              gasUsed: hexToInt(result.gasUsed),
              feeWei: (BigInt(result.gasUsed ?? 0) * BigInt(result.effectiveGasPrice ?? 0)).toString(),
              reverted: result.status === "0x0",
            })
          }
          return result
        } catch (e) {
          bus.emit("rpc", {
            method: args.method,
            ms: Math.round(performance.now() - t0),
            ok: false,
          })
          throw e
        }
      },
    }
  }
}

/** Wallet client with both observation points installed. */
export function makeInstrumentedClient(bus, privateKey = getPrivateKey()) {
  return createWalletClient({
    chain: CHAIN,
    transport: instrumentedHttp(RPC_URL, bus),
    pollingInterval: POLLING_INTERVAL,
    account: privateKeyToAccount(privateKey),
    payloadProvider: {
      url: PAYLOAD_URL,
      namespace: NAMESPACE,
      bearerKey: getBearerKey(),
      fetch: instrumentedFetch(bus),
    },
  })
}

/**
 * Predict the entity keys the SDK will derive for the next `count` creates:
 * keccak256(chainId ‖ registry ‖ owner ‖ nonce+i), nonce read from the registry.
 * Safe with a single wallet and sequential batches (nobody else advances the
 * nonce between this read and the tx). Used only to label live payload uploads
 * with filenames — the authoritative keys come back from mutateEntities.
 */
export async function deriveNextEntityKeys(client, count) {
  const owner = client.account.address
  const nonce = BigInt(
    await client.readContract({
      address: ARKIV_ADDRESS,
      abi: NONCES_ABI,
      functionName: "nonces",
      args: [owner],
    }),
  )
  return Array.from({ length: count }, (_, i) =>
    keccak256(
      encodePacked(
        ["uint256", "address", "address", "uint32"],
        [BigInt(client.chain.id), ARKIV_ADDRESS, owner, Number(nonce + BigInt(i))],
      ),
    ),
  )
}
