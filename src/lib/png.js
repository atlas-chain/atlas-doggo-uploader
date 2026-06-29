// Tiny dependency-free PNG generator (8-bit RGBA), used to fabricate test
// images: a smooth gradient (compresses small) for the hello-world, and a
// deterministic-noise image (incompressible, predictable size) for the
// ~100KB load test.

import { deflateSync } from "node:zlib"

// --- CRC32 (PNG chunk checksum) ---
const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const typeBuf = Buffer.from(type, "ascii")
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0)
  return Buffer.concat([len, typeBuf, data, crc])
}

// Deterministic PRNG so generated images are reproducible across runs.
function mulberry32(seed) {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * Build a valid 8-bit RGBA PNG.
 * @param {object} o
 * @param {number} o.width
 * @param {number} o.height
 * @param {number} [o.seed=1]
 * @param {boolean} [o.noise=false]  true => incompressible random pixels (size ~ w*h*4)
 * @returns {Uint8Array}
 */
export function makePng({ width, height, seed = 1, noise = false }) {
  const rnd = mulberry32(seed)
  const stride = width * 4
  // raw scanlines: each row prefixed with a filter byte (0 = none)
  const raw = Buffer.alloc(height * (stride + 1))
  let p = 0
  for (let y = 0; y < height; y++) {
    raw[p++] = 0 // filter: none
    for (let x = 0; x < width; x++) {
      let r, g, b
      if (noise) {
        r = (rnd() * 256) | 0
        g = (rnd() * 256) | 0
        b = (rnd() * 256) | 0
      } else {
        r = (x * 255 / width) | 0
        g = (y * 255 / height) | 0
        b = ((x + y) * 255 / (width + height)) | 0
      }
      raw[p++] = r
      raw[p++] = g
      raw[p++] = b
      raw[p++] = 255 // alpha
    }
  }

  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // color type: RGBA
  ihdr[10] = 0 // compression
  ihdr[11] = 0 // filter
  ihdr[12] = 0 // interlace
  const idat = deflateSync(raw, { level: noise ? 0 : 6 })

  return new Uint8Array(
    Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", Buffer.alloc(0))]),
  )
}

/**
 * Generate a noisy RGBA PNG whose byte size is approximately `targetBytes`.
 * Noise is incompressible, so encoded size ≈ width*height*4 + overhead; we pick
 * a near-square size to land close to the target (handy for the 100KB load test).
 */
export function makePngOfApproxSize(targetBytes, seed = 1) {
  const pixels = Math.max(1, Math.round((targetBytes - 64) / 4))
  const side = Math.max(1, Math.round(Math.sqrt(pixels)))
  return makePng({ width: side, height: side, seed, noise: true })
}
