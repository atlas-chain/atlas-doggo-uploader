// Read-side helpers that work around an SDK-vs-RPC skew in @atlas-chain/sdk 0.6.15.
//
// The live Atlas RPC returns entity attributes as a single `attributes` array of
// { key, valueType, value }, but the SDK's entityFromRpcResult only reads the
// legacy `stringAttributes` / `numericAttributes` fields — so getEntity()/query
// hand back EMPTY attributes even though server-side attribute filtering works.
//
// These helpers issue raw `arkiv_query` calls (same wire format as the SDK's
// query engine) and map attributes correctly, plus fetch payload bytes directly
// from the public payload provider. The viewer app reads through these.

import { numberToHex } from "@atlas-chain/sdk"
import { PAYLOAD_URL } from "./atlas.js"

// AttributeValueType (from the SDK / on-chain ABI): Uint=1, String=2, EntityKey=3
export function normalizeAttributes(attrs = []) {
  return attrs.map(({ key, valueType, value }) => {
    if (valueType === 1) {
      const n = typeof value === "string" && value.startsWith("0x") ? BigInt(value) : BigInt(value)
      return { key, value: n <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(n) : n }
    }
    return { key, value } // 2 = string, 3 = entity key (hex)
  })
}

function buildQueryString({ filters = {}, ownedBy, createdBy }) {
  const parts = []
  for (const [key, value] of Object.entries(filters)) {
    parts.push(typeof value === "string" ? `${key} = "${value}"` : `${key} = ${value}`)
  }
  if (ownedBy) parts.push(`$owner=${ownedBy}`)
  if (createdBy) parts.push(`$creator=${createdBy}`)
  return parts.join(" && ")
}

/**
 * Raw attribute-aware query. Returns { entities, cursor, blockNumber } where each
 * entity has normalized attributes plus payloadRef/contentType/owner.
 */
export async function queryEntitiesRaw(
  client,
  { filters = {}, ownedBy, createdBy, limit, cursor, orderBy, withMetadata = true } = {},
) {
  const query = buildQueryString({ filters, ownedBy, createdBy })
  const options = {
    includeData: {
      key: true,
      attributes: true,
      payloadReference: true,
      contentType: withMetadata,
      owner: withMetadata,
      creator: withMetadata,
      expiration: withMetadata,
      createdAtBlock: withMetadata,
      lastModifiedAtBlock: withMetadata,
    },
  }
  if (limit !== undefined) options.resultsPerPage = numberToHex(limit)
  if (cursor !== undefined) options.cursor = cursor
  if (orderBy !== undefined) options.orderBy = orderBy

  const res = await client.request({ method: "arkiv_query", params: [query, options] })
  const entities = (res.data ?? []).map((e) => ({
    key: e.key,
    contentType: e.contentType ?? e.payloadRef?.contentType,
    owner: e.owner,
    creator: e.creator,
    payloadRef: e.payloadRef,
    attributes: normalizeAttributes(e.attributes),
  }))
  return { entities, cursor: res.cursor, blockNumber: res.blockNumber }
}

/** Fetch raw payload bytes directly from the public provider (no bearer needed). */
export async function fetchPayloadRaw(id) {
  const res = await fetch(`${PAYLOAD_URL}/payloads/${id}/raw`)
  if (!res.ok) throw new Error(`payload fetch ${id} failed: HTTP ${res.status}`)
  return new Uint8Array(await res.arrayBuffer())
}
