import { IDENTITY } from "../../sites/docs/src/lib/content.ts"
import { type DeploymentManifest, sourceManifest } from "../../sites/docs/src/lib/deployment.ts"
import { discoverPackages, REPO } from "../release/lib.ts"
import { loadHosting } from "./hosting.ts"
import { github, INVENTORY_URL, inspect, MAIN_RAW, pool, request } from "./io.ts"
import { type HealthItem, report } from "./report.ts"

export function catalogHealth(expected: string[], body: unknown): HealthItem {
  if (
    !body ||
    typeof body !== "object" ||
    !Array.isArray((body as { services?: unknown }).services)
  )
    return { id: "catalog", status: "fail", message: "Deployed catalog is malformed." }
  const services = (body as { services: Array<{ package?: string }> }).services
  const names = new Set(services.map((service) => service.package))
  const missing = expected.filter((name) => !names.has(name))
  const extra = [...names].filter((name) => !name || !expected.includes(name))
  return {
    id: "catalog",
    status: missing.length || extra.length || names.size !== services.length ? "fail" : "ok",
    message:
      missing.length || extra.length
        ? `Missing: ${missing.join(", ") || "none"}; unexpected: ${extra.join(", ") || "none"}.`
        : names.size !== services.length
          ? "Catalog contains duplicate package entries."
          : `All ${expected.length} public service packages appear exactly once.`,
  }
}

export function webhookReadHealth(status: number, configured: boolean | undefined): HealthItem {
  if (status === 401)
    return {
      id: "webhook-read-protection",
      status: "ok",
      message: "Unauthenticated event reads are rejected.",
    }
  if (status === 503 && configured === false)
    return {
      id: "webhook-read-protection",
      status: "optional",
      message:
        "Optional webhook receiver has no read token declared in fleet inventory; reads fail closed.",
      remedy:
        "Configure WEBHOOK_READ_TOKEN in crvouga/workspace only when enabling deployed webhook parity.",
    }
  return {
    id: "webhook-read-protection",
    status: status === 503 && configured === undefined ? "unknown" : "fail",
    message:
      status === 503
        ? "Webhook read token is unavailable; deployed receiver configuration must be checked."
        : `Unexpected unauthenticated read status ${status}.`,
    remedy:
      "Check WEBHOOK_READ_TOKEN in the fleet's runtime secret bindings; event reads must never be public.",
  }
}

export function deploymentManifestHealth(value: unknown, expected: DeploymentManifest): HealthItem {
  const live = (value ?? {}) as Partial<DeploymentManifest>
  const valid =
    live.schemaVersion === 1 &&
    live.service === "mockingbird-docs" &&
    live.algorithm === expected.algorithm &&
    typeof live.fingerprint === "string" &&
    /^[0-9a-f]{64}$/.test(live.fingerprint) &&
    typeof live.files === "number" &&
    Number.isInteger(live.files) &&
    live.files > 0
  return {
    id: "deployment-revision",
    status:
      valid && live.fingerprint === expected.fingerprint && live.files === expected.files
        ? "ok"
        : "fail",
    message: !valid
      ? "Live deployment manifest is malformed."
      : live.fingerprint === expected.fingerprint && live.files === expected.files
        ? `Deployed source fingerprint matches main (${live.files} source files).`
        : "The running docs image was built from different source than current main.",
    remedy:
      "Publish main's docs image through the managed publish workflow and check the downstream fleet deployment.",
  }
}

export async function runDocsHealth() {
  const items: HealthItem[] = []
  let base = IDENTITY.docs
  let webhookConfigured: boolean | undefined
  items.push(
    await inspect("fleet-inventory", async () => {
      const service = await loadHosting()
      webhookConfigured = Boolean(
        service.env?.WEBHOOK_READ_TOKEN?.trim() ||
          service.secrets?.some((secret) => secret.name === "WEBHOOK_READ_TOKEN"),
      )
      const problems: string[] = []
      if (
        service.github_repo !== REPO ||
        service.dockerfile !== "sites/docs/Dockerfile" ||
        service.build_context !== "."
      )
        problems.push(
          "source repository, Dockerfile, or build context differs from the docs publishing contract",
        )
      if (!service.health_check || service.port !== 80)
        problems.push("health checks must be enabled on port 80")
      if (`https://${service.hostname}` !== IDENTITY.docs)
        problems.push("public docs URL differs from fleet inventory")
      if (!problems.length) base = `https://${service.hostname}`
      return {
        id: "fleet-inventory",
        status: problems.length ? "fail" : "ok",
        message:
          problems.join("; ") || "Fresh hosting contract and authoritative fleet inventory agree.",
        url: INVENTORY_URL,
        ...(problems.length
          ? { remedy: "Correct the managed hosting configuration in crvouga/workspace." }
          : {}),
      }
    }),
  )
  const routes = [
    "/",
    "/services",
    "/docs/development",
    "/docs/development.md",
    "/services/stripe",
    "/services/stripe.md",
    "/services/postgres",
    "/services/postgres.md",
    "/search.json",
    "/llms-full.txt",
  ]
  items.push(
    ...(await pool(
      routes,
      (path) =>
        inspect(path, async () => {
          const response = await request(`${base}${path}`)
          const content = await response.text()
          const expected = path.endsWith(".json")
            ? content.trim().startsWith("[") || content.trim().startsWith("{")
            : path.endsWith(".md") || path.endsWith(".txt")
              ? content.length > 100 && !/<!doctype html/i.test(content)
              : /mockingbird/i.test(content)
          return {
            id: path,
            status: response.ok && expected ? "ok" : "fail",
            message: `HTTP ${response.status}; ${expected ? "expected content present" : "unexpected or empty content"}.`,
            url: `${base}${path}`,
          }
        }),
      4,
    )),
  )
  items.push(
    await inspect("catalog", async () => {
      const response = await request(`${base}/catalog.json`)
      if (!response.ok) throw new Error(`Catalog HTTP ${response.status}`)
      const value = catalogHealth(
        discoverPackages()
          .filter((pkg) => pkg.isPublic && pkg.name.startsWith("@crvouga/mockingbird-service-"))
          .map((pkg) => pkg.name),
        await response.json(),
      )
      return {
        ...value,
        url: `${base}/catalog.json`,
        ...(value.status !== "ok"
          ? {
              remedy:
                "Compare main's service catalog and the deployed docs image; unmerged local services are not deployed yet.",
            }
          : {}),
      }
    }),
  )
  items.push(
    await inspect("llms-freshness", async () => {
      const [live, main] = await Promise.all([
        request(`${base}/llms.txt`),
        request(`${MAIN_RAW}/llms.txt`),
      ])
      if (!live.ok || !main.ok)
        throw new Error(`llms HTTP live=${live.status}, main=${main.status}`)
      const same = (await live.text()).trim() === (await main.text()).trim()
      return {
        id: "llms-freshness",
        status: same ? "ok" : "fail",
        message: same
          ? "Deployed llms.txt matches current main."
          : "Deployed llms.txt differs from main (stale docs or failed deployment).",
        url: `${base}/llms.txt`,
        remedy: "Inspect Publish image and the downstream crvouga/workspace deployment.",
      }
    }),
  )
  items.push(
    await inspect("webhook-runtime", async () => {
      const response = await request(`${base}/webhook/__admin/health`)
      const body = (await response.json()) as { status?: string }
      return {
        id: "webhook-runtime",
        status: response.ok && body.status === "ok" ? "ok" : "fail",
        message: `Webhook collector health HTTP ${response.status}; status ${body.status ?? "missing"}.`,
        url: `${base}/webhook/__admin/health`,
      }
    }),
  )
  items.push(
    await inspect("webhook-read-protection", async () => {
      // Read no events and send no credentials. A healthy protected collector rejects this request.
      const response = await request(`${base}/webhook/__admin/events`)
      await response.body?.cancel()
      return webhookReadHealth(response.status, webhookConfigured)
    }),
  )
  items.push(
    await inspect("deployment-revision", async () => {
      const response = await request(`${base}/health.json`)
      if (response.status === 404)
        return {
          id: "deployment-revision",
          status: "unknown",
          message: "The deployed docs image predates the source fingerprint endpoint.",
          remedy:
            "Publish this change to main through the managed docs workflow; no shared workflow or new secret is required.",
        }
      if (!response.ok) throw new Error(`Deployment manifest HTTP ${response.status}`)
      const live = (await response.json()) as DeploymentManifest
      const tree = await github<{
        truncated: boolean
        tree: Array<{ path: string; sha: string; type: string }>
      }>(`repos/${REPO}/git/trees/main?recursive=1`)
      if (tree.truncated || !Array.isArray(tree.tree))
        throw new Error("GitHub did not return a complete source tree")
      const expected = sourceManifest(tree.tree.filter((entry) => entry.type === "blob"))
      return deploymentManifestHealth(live, expected)
    }),
  )
  return report("docs", "Docs deployment and webhook runtime", items)
}
