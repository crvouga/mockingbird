export type PreviewDownload = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

export type PreviewArtifact = {
  format: 1
  commit: string
  sha256: string
  bytes: number
  encoding: "identity" | "gzip"
  url: string
}
export type LegacyPreviewArtifact = {
  version: 1
  sha256: string
  url: string
  compression?: "gzip"
}
const legacyArtifact = (value: unknown): LegacyPreviewArtifact | undefined => {
  if (!value || typeof value !== "object" || !("version" in value)) return undefined
  const artifact = value as LegacyPreviewArtifact
  if (artifact.version !== 1) throw new Error("Unsupported preview artifact version")
  if (
    typeof artifact.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(artifact.sha256) ||
    typeof artifact.url !== "string" ||
    !artifact.url ||
    (artifact.compression !== undefined && artifact.compression !== "gzip")
  )
    throw new Error("Invalid legacy preview artifact manifest")
  return artifact
}
const HEX = /^[0-9a-f]{64}$/
export function parsePreviewArtifact(value: unknown): PreviewArtifact {
  if (!value || typeof value !== "object") throw new Error("Invalid preview artifact manifest")
  const item = value as Partial<PreviewArtifact>
  if (
    item.format !== 1 ||
    typeof item.commit !== "string" ||
    !item.commit ||
    typeof item.sha256 !== "string" ||
    !HEX.test(item.sha256) ||
    !Number.isSafeInteger(item.bytes) ||
    (item.bytes ?? -1) < 0 ||
    !["identity", "gzip"].includes(item.encoding ?? "") ||
    typeof item.url !== "string" ||
    !item.url
  )
    throw new Error("Unsupported or invalid preview artifact manifest")
  return item as PreviewArtifact
}
export async function digestPreviewBytes(bytes: Uint8Array) {
  const hash = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes))
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("")
}
export async function createPreviewArtifact(
  bytes: Uint8Array,
  options: { commit: string; encoding?: "identity" | "gzip"; url: string },
): Promise<PreviewArtifact> {
  return parsePreviewArtifact({
    format: 1,
    commit: options.commit,
    url: options.url,
    encoding: options.encoding ?? "identity",
    bytes: bytes.length,
    sha256: await digestPreviewBytes(bytes),
  })
}
const boundedBytes = async (stream: ReadableStream<Uint8Array>, maximum: number) => {
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const next = await reader.read()
      if (next.done) break
      size += next.value.byteLength
      if (size > maximum) throw new Error("Preview asset exceeds size limit")
      chunks.push(next.value)
    }
  } catch (error) {
    await reader.cancel().catch(() => {})
    throw error
  } finally {
    reader.releaseLock()
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}
export async function loadPreviewArtifact(
  manifest: unknown,
  options: {
    fetch?: PreviewDownload
    expectedCommit?: string
    maximumBytes?: number
    signal?: AbortSignal
  } = {},
) {
  const legacy = legacyArtifact(manifest)
  const artifact = legacy
    ? {
        url: legacy.url,
        commit: undefined,
        bytes: undefined,
        sha256: legacy.sha256,
        encoding: legacy.compression ?? "identity",
      }
    : parsePreviewArtifact(manifest)
  if (options.expectedCommit !== undefined && artifact.commit !== options.expectedCommit)
    throw new Error("Stale preview artifact commit")
  const maximum = options.maximumBytes ?? 128 * 1024 * 1024
  if (
    !Number.isSafeInteger(maximum) ||
    maximum < 1 ||
    (artifact.bytes !== undefined && artifact.bytes > maximum)
  )
    throw new Error("Preview asset exceeds size limit")
  let response: Response
  try {
    response = await (options.fetch ?? fetch)(artifact.url, {
      cache: "no-store",
      redirect: "error",
      credentials: "omit",
      ...(options.signal ? { signal: options.signal } : {}),
    })
  } catch {
    throw new Error("Preview asset download failed")
  }
  if (!response.ok || !response.body)
    throw new Error(`Preview asset download failed (${response.status})`)
  const bytes = await boundedBytes(response.body, maximum)
  if (
    !legacy &&
    (bytes.byteLength !== artifact.bytes || (await digestPreviewBytes(bytes)) !== artifact.sha256)
  )
    throw new Error("Preview asset integrity mismatch")
  let decoded = bytes
  if (artifact.encoding === "gzip") {
    try {
      decoded = await boundedBytes(
        new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip")),
        maximum,
      )
    } catch {
      throw new Error("Preview asset decompression failed or exceeds size limit")
    }
  }
  if (legacy && (await digestPreviewBytes(decoded)) !== artifact.sha256)
    throw new Error("Preview artifact identity mismatch")
  return decoded
}
