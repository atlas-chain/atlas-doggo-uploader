// Access to the real dog-image dataset the user dropped in ../Images/Dogs
// (~75k 256x256 PNGs, ~95KB each — perfect for the ~100KB load test).

import { readdirSync, existsSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..")
// atlas-apps/../Images/Dogs == Atlas-Workspace/Images/Dogs
export const DOGS_DIR = join(ROOT, "..", "Images", "Dogs")

let _cache = null
/** All dog PNG file names (cached). */
export function listDogNames(limit = Infinity) {
  if (!_cache) {
    if (!existsSync(DOGS_DIR)) throw new Error(`dog dataset not found at ${DOGS_DIR}`)
    _cache = readdirSync(DOGS_DIR).filter((n) => n.endsWith(".png"))
  }
  return limit === Infinity ? _cache : _cache.slice(0, limit)
}

export const dogPath = (name) => join(DOGS_DIR, name)

/** A single dog image path — defaults to dog_1.png, falls back to the first found. */
export function pickDog(name = "dog_1.png") {
  const p = dogPath(name)
  if (existsSync(p)) return p
  const first = listDogNames(1)[0]
  if (!first) throw new Error(`no PNGs in ${DOGS_DIR}`)
  return dogPath(first)
}
