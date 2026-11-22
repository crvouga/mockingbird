/**
 * Files over a host's per-file limit (25 MiB on Workers static assets), shipped as numbered parts
 * next to a SHA-256 manifest and joined again in the browser. `splitLargePreviewFiles`
 * (`@crvouga/mockingbird-preview/node`, or `mockingbird-preview check --split`) writes them;
 * `loadSplitPreviewFile` fetches the parts, checks every part's and the whole file's size and
 * SHA-256, and returns the original bytes.
 *
 *   big.wasm            →  big.wasm.parts.json  { format: 1, path, bytes, sha256, parts: [...] }
 *                          big.wasm.part-000, big.wasm.part-001, …
 *
 * Portable: Fetch and Web Crypto only.
 */
import { digestPreviewBytes, type PreviewDownload } from "./artifacts.js"

/** The suffix of a split file's manifest: `<file>.parts.json`. */
export const PREVIEW_SPLIT_MANIFEST_SUFFIX = ".parts.json"

/** One numbered part of a split file. `path` is relative to the manifest's directory. */
export type PreviewSplitPart = { path: string; bytes: number; sha256: string }

/** `<file>.parts.json`: the original file's size and SHA-256, and its parts in order. */
export type PreviewSplitManifest = {
  format: 1
  /** The original file's name, relative to the manifest's directory. */
  path: string
  bytes: number
  sha256: string
  parts: PreviewSplitPart[]
}

const HEX = /^[0-9a-f]{64}$/
const SAFE_NAME = /^[^/\\]+$/

const validSize = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0

/** Validates a parsed `<file>.parts.json`; throws on anything malformed. */
export function parsePreviewSplitManifest(value: unknown): PreviewSplitManifest {
  const item = (value ?? {}) as Partial<PreviewSplitManifest>
  if (
    item.format !== 1 ||
    typeof item.path !== "string" ||
    !SAFE_NAME.test(item.path) ||
    !validSize(item.bytes) ||
    typeof item.sha256 !== "string" ||
    !HEX.test(item.sha256) ||
    !Array.isArray(item.parts) ||
    item.parts.length === 0
  )
    throw new Error("Invalid split preview file manifest")
  let total = 0
  for (const part of item.parts) {
    if (
      !part ||
      typeof part.path !== "string" ||
      !SAFE_NAME.test(part.path) ||
      part.path === "." ||
      part.path === ".." ||
      !validSize(part.bytes) ||
      typeof part.sha256 !== "string" ||
      !HEX.test(part.sha256)
    )
      throw new Error("Invalid split preview file manifest")
    total += part.bytes
  }
  if (total !== item.bytes) throw new Error("Split preview file parts do not add up to its size")
  return item as PreviewSplitManifest
}

/** The name of a file's part `index`: `<file>.part-000`, `<file>.part-001`, … */
export const previewSplitPartName = (file: string, index: number) =>
  `${file}.part-${String(index).padStart(3, "0")}`

/**
 * Loads a file that may have been split: fetches `<url>.parts.json`; when it exists, fetches every
 * part, verifies each part's size and SHA-256 and the joined file's, and returns the original
 * bytes. When there is no manifest (HTTP 404) it fetches `url` itself, so the same call works for a
 * file that was small enough to ship whole.
 */
export async function loadSplitPreviewFile(
  url: string | URL,
  options: { fetch?: PreviewDownload; signal?: AbortSignal } = {},
): Promise<Uint8Array> {
  const doFetch = options.fetch ?? ((input, init) => fetch(input, init))
  const init = options.signal ? { signal: options.signal } : {}
  const target = new URL(
    String(url),
    (globalThis as { location?: { href: string } }).location?.href,
  )
  const manifestUrl = new URL(`${target.pathname}${PREVIEW_SPLIT_MANIFEST_SUFFIX}`, target)
  const found = await doFetch(manifestUrl, init)
  if (found.status === 404) {
    await found.body?.cancel().catch(() => {})
    const whole = await doFetch(target, init)
    if (!whole.ok) throw new Error(`${target.pathname}: HTTP ${whole.status}`)
    return new Uint8Array(await whole.arrayBuffer())
  }
  if (!found.ok) throw new Error(`${manifestUrl.pathname}: HTTP ${found.status}`)
  const manifest = parsePreviewSplitManifest(await found.json())
  const joined = new Uint8Array(manifest.bytes)
  let offset = 0
  for (const part of manifest.parts) {
    const response = await doFetch(new URL(part.path, manifestUrl), init)
    if (!response.ok) throw new Error(`${part.path}: HTTP ${response.status}`)
    const bytes = new Uint8Array(await response.arrayBuffer())
    if (bytes.byteLength !== part.bytes || (await digestPreviewBytes(bytes)) !== part.sha256)
      throw new Error(`${part.path} does not match its SHA-256 in ${manifest.path}.parts.json`)
    joined.set(bytes, offset)
    offset += bytes.byteLength
  }
  if ((await digestPreviewBytes(joined)) !== manifest.sha256)
    throw new Error(`${manifest.path}: the joined parts do not match its SHA-256`)
  return joined
}
