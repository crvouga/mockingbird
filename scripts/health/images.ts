import { REPO } from "../release/lib.ts"
import { inspect, json, request, workflowRuns } from "./io.ts"
import { type HealthItem, report } from "./report.ts"

const IMAGE = "crvouga/chrisvouga-mockingbird-docs"
const ACCEPT =
  "application/vnd.oci.image.index.v1+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json, application/vnd.docker.distribution.manifest.list.v2+json"
type ImageManifest = {
  schemaVersion?: number
  config?: { digest: string }
  manifests?: Array<{ digest: string; platform?: { os: string; architecture: string } }>
}

export async function runImageHealth() {
  const items: HealthItem[] = []
  const result = await inspect("docs-image", async () => {
    const auth = await json<{ token?: string }>(
      `https://ghcr.io/token?scope=repository%3A${encodeURIComponent(IMAGE)}%3Apull`,
    )
    if (!auth.token) throw new Error("GHCR did not grant anonymous pull access")
    const headers = { authorization: `Bearer ${auth.token}`, accept: ACCEPT }
    const manifest = async (ref: string) => {
      const response = await request(`https://ghcr.io/v2/${IMAGE}/manifests/${ref}`, { headers })
      if (!response.ok) throw new Error(`GHCR manifest HTTP ${response.status}`)
      return {
        digest: response.headers.get("docker-content-digest"),
        body: (await response.json()) as ImageManifest,
      }
    }
    const latest = await manifest("latest")
    if (latest.body.schemaVersion !== 2 || !latest.digest)
      throw new Error("GHCR returned invalid image metadata")
    items.push({
      id: "anonymous-pull",
      status: "ok",
      message: `ghcr.io/${IMAGE}:latest is publicly pullable (${latest.digest}).`,
    })
    let body = latest.body
    if (body.manifests) {
      const amd64 = body.manifests.find(
        (entry) => entry.platform?.os === "linux" && entry.platform.architecture === "amd64",
      )
      if (!amd64) throw new Error("Image index is missing linux/amd64")
      body = (await manifest(amd64.digest)).body
    }
    if (!body.config?.digest) throw new Error("Image has no config descriptor")
    const config = await json<{
      os?: string
      architecture?: string
      config?: { ExposedPorts?: Record<string, unknown>; Cmd?: string[] }
    }>(`https://ghcr.io/v2/${IMAGE}/blobs/${body.config.digest}`, { headers })
    items.push({
      id: "image-platform",
      status: config.os === "linux" && config.architecture === "amd64" ? "ok" : "fail",
      message: `Platform ${config.os}/${config.architecture}.`,
    })
    items.push({
      id: "image-port",
      status: config.config?.ExposedPorts?.["80/tcp"] ? "ok" : "fail",
      message: "Docs image must expose fleet port 80.",
    })
    const runs = await workflowRuns("publish.yml")
    const newest = runs[0]
    const published = runs.find((run) => run.status === "completed" && run.conclusion === "success")
    if (!published) throw new Error("No successful docs image publish on main was found")
    const tagged = await manifest(published.head_sha)
    items.push({
      id: "image-freshness",
      status: latest.digest === tagged.digest ? "ok" : "fail",
      message:
        latest.digest === tagged.digest
          ? `latest matches successful publish ${published.head_sha.slice(0, 12)}.`
          : "latest differs from the most recent successful publish's immutable SHA tag.",
      url: published.html_url,
    })
    if (newest?.id !== published.id)
      items.push({
        id: "latest-publish",
        status: newest?.status !== "completed" ? "pending" : "fail",
        message: "A newer docs publish is pending or failed.",
        url: newest?.html_url ?? `https://github.com/${REPO}/actions/workflows/publish.yml`,
      })
    return { id: "docs-image", status: "ok", message: "Image inspected." }
  })
  if (result.status !== "ok") items.push(result)
  return report("images", "GHCR docs image", items)
}
