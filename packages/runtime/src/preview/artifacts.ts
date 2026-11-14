import type { WebFetch } from "./types.js"

export type PreviewArtifact = {
  version: 1
  /** SHA-256 of the decoded JavaScript bytes, as lowercase hex. */
  sha256: string
  url: string
  compression?: "gzip"
}

/** Verify before execution. URLs inside a compressed bundle must be absolute or bundled. */
export async function loadPreviewArtifact(
  artifact: PreviewArtifact,
  fetcher: WebFetch = fetch,
): Promise<Uint8Array<ArrayBuffer>> {
  if (artifact.version !== 1) throw new Error("Unsupported preview artifact version")
  if (!/^[a-f0-9]{64}$/.test(artifact.sha256)) throw new Error("Invalid preview artifact SHA-256")
  if (artifact.compression !== undefined && artifact.compression !== "gzip")
    throw new Error("Unsupported preview artifact compression")
  const response = await fetcher(artifact.url, { cache: "no-store", credentials: "omit" })
  if (!response.ok || !response.body)
    throw new Error(`Preview artifact ${artifact.url}: HTTP ${response.status}`)
  const stream =
    artifact.compression === "gzip"
      ? response.body.pipeThrough(new DecompressionStream("gzip"))
      : response.body
  const bytes = new Uint8Array(await new Response(stream).arrayBuffer())
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))
  const identity = [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("")
  if (identity !== artifact.sha256)
    throw new Error(`Preview artifact identity mismatch: ${artifact.url}`)
  return bytes
}

export async function createPreviewWorker(artifact: PreviewArtifact, options: WorkerOptions = {}) {
  const bytes = await loadPreviewArtifact(artifact)
  const url = URL.createObjectURL(new Blob([bytes], { type: "text/javascript" }))
  try {
    const worker = new Worker(url, { ...options, type: "module" })
    return {
      worker,
      identity: artifact.sha256,
      dispose() {
        worker.terminate()
        URL.revokeObjectURL(url)
      },
    }
  } catch (error) {
    URL.revokeObjectURL(url)
    throw error
  }
}
