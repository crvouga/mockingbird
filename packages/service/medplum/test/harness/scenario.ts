/**
 * Scenarios: request sequences sent unchanged to the oracle and to the mock. Values a step
 * needs from an earlier answer (an id, a versionId) are captured per side into `vars`, so
 * each side is addressed with its own ids while the canonical exchanges must agree.
 */

import { ensureSchema } from "../../src/schema.js"
import { type CanonicalExchange, Canonicalizer } from "./canonical.js"
import { entryOrderFor, matchCount } from "./order.js"
import { type Project, provisionProject, type Target } from "./target.js"

export type Vars = Record<string, string> & { projectId: string; clientId: string }

type Dynamic<T> = T | ((vars: Vars) => T)

export type Step = {
  /** Shown in failure reports. Default `METHOD path`. */
  name?: string
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD"
  path: Dynamic<string>
  body?: ((vars: Vars) => unknown) | Record<string, unknown> | unknown[]
  /** Raw body (sent as is). */
  raw?: Dynamic<string>
  headers?: Dynamic<Record<string, string>>
  /** Content type of `body`. Default `application/fhir+json` (JSON bodies). */
  contentType?: string
  /** Credentials: the project client's token (default), the super admin's, Basic client auth, or none. */
  auth?: "project" | "super" | "basic" | "none"
  /** Capture values from the JSON answer: `{ patient: (body) => body.id }`. */
  // biome-ignore lint/suspicious/noExplicitAny: response bodies are arbitrary JSON in tests
  save?: Record<string, (body: any, response: Response) => string | undefined>
  /** Compare `entry` order-insensitively. Default: true for a GET search without `_sort`. */
  unordered?: boolean
  /** Leave this step's answer out of the comparison (setup only). */
  compare?: false
}

export type Scenario = {
  name: string
  steps: Step[]
}

export type ScenarioRecording = {
  name: string
  exchanges: { step: string; exchange: CanonicalExchange | null }[]
}

const resolve = <T>(value: Dynamic<T> | undefined, vars: Vars): T | undefined =>
  typeof value === "function" ? (value as (vars: Vars) => T)(vars) : value

export const stepName = (step: Step, vars: Vars): string =>
  step.name ?? `${step.method} ${resolve(step.path, vars) ?? ""}`

/** Run a scenario on one side, in a freshly provisioned project. */
export const runScenario = async (
  target: Target,
  scenario: Scenario,
  project?: Project,
): Promise<ScenarioRecording> => {
  await ensureSchema()
  const provisioned =
    project ?? (await provisionProject(target, `Parity ${scenario.name}`.slice(0, 60)))
  const canonical = new Canonicalizer(target.baseUrl)
  canonical.name(provisioned.projectId, "project")
  canonical.name(provisioned.clientId, "client")
  const vars: Vars = {
    projectId: provisioned.projectId,
    clientId: provisioned.clientId,
    clientSecret: provisioned.clientSecret,
  }
  const exchanges: ScenarioRecording["exchanges"] = []
  for (const step of scenario.steps) {
    const path = resolve(step.path, vars) as string
    const headers = new Headers(resolve(step.headers, vars) ?? {})
    // The same client identity on both sides (in-process requests carry no User-Agent).
    if (!headers.has("user-agent")) headers.set("user-agent", "mockingbird-parity/1.0")
    const auth = step.auth ?? "project"
    if (auth === "project") headers.set("authorization", `Bearer ${provisioned.token}`)
    if (auth === "super") headers.set("authorization", `Bearer ${provisioned.superToken}`)
    if (auth === "basic") {
      headers.set(
        "authorization",
        `Basic ${btoa(`${provisioned.clientId}:${provisioned.clientSecret}`)}`,
      )
    }
    let body: string | undefined
    const raw = resolve(step.raw, vars)
    const json = resolve(step.body, vars)
    if (raw !== undefined) body = raw
    else if (json !== undefined) body = JSON.stringify(json)
    if (body !== undefined && !headers.has("content-type")) {
      headers.set("content-type", step.contentType ?? "application/fhir+json")
    }
    const response = await target.fetch(
      new Request(new URL(path.replace(/^\//, ""), target.baseUrl), {
        method: step.method,
        headers,
        body,
      }),
    )
    if (step.save) {
      const text = await response.clone().text()
      let parsed: unknown
      try {
        parsed = JSON.parse(text)
      } catch {
        parsed = undefined
      }
      for (const [key, pick] of Object.entries(step.save)) {
        const value = pick(parsed, response)
        if (value !== undefined) vars[key] = value
      }
    }
    const name = step.name ?? `${step.method} ${canonical.string(path)}`
    if (step.compare === false) {
      await response.body?.cancel()
      exchanges.push({ step: name, exchange: null })
      continue
    }
    const matches = matchCount(
      await response
        .clone()
        .json()
        .catch(() => undefined),
    )
    const order =
      step.unordered === true
        ? ({ kind: "unordered" } as const)
        : entryOrderFor(step.method, path, matches)
    exchanges.push({
      step: name,
      exchange: await canonical.exchange(response, { unorderedEntries: order }),
    })
  }
  return { name: scenario.name, exchanges }
}
