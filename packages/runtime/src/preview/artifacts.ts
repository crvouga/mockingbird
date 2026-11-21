import {
  type LegacyPreviewArtifact,
  loadPreviewArtifact as loadArtifact,
} from "@crvouga/mockingbird-preview"
import type { WebFetch } from "./types.js"
export type PreviewArtifact = LegacyPreviewArtifact
export const loadPreviewArtifact = (artifact: PreviewArtifact, fetcher: WebFetch = fetch) =>
  loadArtifact(artifact, { fetch: fetcher })

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
