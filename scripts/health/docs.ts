import { IDENTITY } from "../../sites/docs/src/lib/content.ts"
import { discoverPackages, REPO } from "../release/lib.ts"
import { loadHosting } from "./hosting.ts"
import { INVENTORY_URL, inspect, MAIN_RAW, pool, request, workflowRuns } from "./io.ts"
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

export function deploymentRevisionHealth(revision: string | null, expected?: string): HealthItem {
  if (!revision || !/^[a-f0-9]{40}$/.test(revision))
    return {
      id: "deployment-revision",
      status: "unknown",
      message:
        "The live docs do not expose a valid immutable source revision; HTTP/content checks cannot prove the exact running image.",
      remedy:
        "Expose x-mockingbird-revision from the built docs image using the source commit supplied by the shared publish workflow.",
    }
  if (!expected)
    return {
      id: "deployment-revision",
      status: "unknown",
      message:
        "The running revision is visible, but there is no successful image publish to compare.",
    }
  return {
    id: "deployment-revision",
    status: revision === expected ? "ok" : "fail",
    message:
      revision === expected
        ? `Running docs match published source ${revision.slice(0, 12)}.`
        : `Running source ${revision.slice(0, 12)} differs from published ${expected.slice(0, 12)}.`,
    ...(revision !== expected
      ? { remedy: "Inspect the downstream fleet deployment in crvouga/workspace." }
      : {}),
  }
}

export async function runDocsHealth() {
  const items: HealthItem[] = []
  let base = IDENTITY.docs
  items.push(
    await inspect("fleet-inventory", async () => {
      const service = await loadHosting()
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
          .filter((pkg) => pkg.isPublic)
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
      return {
        id: "webhook-read-protection",
        status: response.status === 401 ? "ok" : "fail",
        message:
          response.status === 401
            ? "Unauthenticated event reads are rejected."
            : response.status === 503
              ? "Webhook read token is not configured in the deployed service."
              : `Unexpected unauthenticated read status ${response.status}.`,
        remedy:
          "Configure WEBHOOK_READ_TOKEN in the fleet's runtime secret bindings; never expose event reads publicly.",
      }
    }),
  )
  items.push(
    await inspect("deployment-revision", async () => {
      const response = await request(`${base}/`)
      const revision = response.headers.get("x-mockingbird-revision")
      await response.body?.cancel()
      const expected = revision
        ? (await workflowRuns("publish.yml")).find((run) => run.conclusion === "success")?.head_sha
        : undefined
      return deploymentRevisionHealth(revision, expected)
    }),
  )
  return report("docs", "Docs deployment and webhook runtime", items)
}
