/**
 * Observability: what reaches an OTLP collector (the `otel` emulator in server mode, queried
 * through its own admin API), and what happens when there is no collector or it misbehaves.
 * Each scenario exports into its own namespace of the worker's collector.
 */
import { expect } from "@playwright/test"
import {
  type Collector,
  type CollectorRow,
  collectorNamespace,
  type Hosting,
  hosting,
  jsonLines,
} from "../support/hosting.js"
import { freePort, OPERATOR_TOKEN, type Stack, startStack } from "../support/stack.js"
import type { World } from "../support/world.js"
import { Given, Then, When } from "./common.steps.js"

/** The server's flush interval, plus a margin: after this an export has certainly been tried. */
const EXPORT_INTERVAL_MS = 6000

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const collector = (state: Hosting): Collector => {
  if (!state.collector) throw new Error("This scenario has no collector")
  return state.collector
}

async function exportingServer(
  world: World,
  ownStacks: Stack[],
  env: Record<string, string>,
): Promise<void> {
  const stack = await startStack(env)
  ownStacks.push(stack)
  world.stack = stack
}

Given("a server that exports telemetry to a collector", async ({ world, ownStacks }) => {
  const state = hosting(world)
  state.collector = collectorNamespace(world.stack.otelUrl, `spec-${world.tag}`)
  await exportingServer(world, ownStacks, { OTEL_EXPORTER_OTLP_ENDPOINT: state.collector.endpoint })
})

Given(
  "a server that exports telemetry to a collector as the service {string}",
  async ({ world, ownStacks }, service: string) => {
    const state = hosting(world)
    state.collector = collectorNamespace(world.stack.otelUrl, `spec-${world.tag}`)
    await exportingServer(world, ownStacks, {
      OTEL_EXPORTER_OTLP_ENDPOINT: state.collector.endpoint,
      OTEL_SERVICE_NAME: service,
    })
  },
)

Given(
  "a collector that only accepts the bearer token {string}",
  async ({ world }, token: string) => {
    const state = hosting(world)
    state.collector = collectorNamespace(world.stack.otelUrl, `spec-${world.tag}`)
    await state.collector.requireToken(token)
    state.secrets.add(token)
  },
)

Given(
  "a server that exports telemetry to that collector with the header {string}",
  async ({ world, ownStacks }, header: string) => {
    await exportingServer(world, ownStacks, {
      OTEL_EXPORTER_OTLP_ENDPOINT: collector(hosting(world)).endpoint,
      OTEL_EXPORTER_OTLP_HEADERS: header,
    })
  },
)

Given(
  "a server that exports telemetry to a collector that is not running",
  async ({ world, ownStacks }) => {
    await exportingServer(world, ownStacks, {
      OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${await freePort()}`,
    })
  },
)

Given("a server with no OTEL_EXPORTER_OTLP_ENDPOINT", async ({ world, ownStacks }) => {
  await exportingServer(world, ownStacks, {})
  expect(world.stack.env.OTEL_EXPORTER_OTLP_ENDPOINT).toBeUndefined()
  // This stack's own collector: nothing is pointed at it, so it must stay empty.
  hosting(world).collector = collectorNamespace(world.stack.otelUrl)
})

Given("the collector starts answering every export with 503", async ({ world }) => {
  await collector(hosting(world)).breakDown()
})

Given("a fleet with a {string} emulator on that server", async ({ world }, target: string) => {
  const org = await world.must<{ id: string }>("Ada", "POST", "/orgs", { name: "Acme" })
  const project = await world.must<{ id: string }>("Ada", "POST", `/orgs/${org.id}/projects`, {
    name: "Staging",
  })
  const fleet = await world.must<{ slug: string }>(
    "Ada",
    "POST",
    `/projects/${project.id}/fleets`,
    { name: "Traced", emulators: { [target]: { target } } },
  )
  hosting(world).notes.set("fleet", fleet.slug)
  hosting(world).notes.set("emulator", target)
})

// ---- calls --------------------------------------------------------------------------------

const createUser = (world: World, headers: Record<string, string> = {}) =>
  world.api("operator", "POST", "/admin/users", { email: world.email("traced") }, { headers })

When(
  "the operator calls the API inside the trace {string} from span {string}",
  async ({ world }, trace: string, span: string) => {
    hosting(world).notes.set("trace", trace).set("caller span", span)
    await createUser(world, { traceparent: `00-${trace}-${span}-01` })
    expect(world.last?.status, world.last?.text).toBe(201)
  },
)

When("the operator calls the API with no trace context", async ({ world }) => {
  await createUser(world)
})

When(
  "the operator calls the API with the traceparent {string}",
  async ({ world }, traceparent: string) => {
    await createUser(world, { traceparent })
    expect(world.last?.status, world.last?.text).toBe(201)
  },
)

When(
  "a client calls the emulator inside the trace {string} from span {string}",
  async ({ world }, trace: string, span: string) => {
    const { notes } = hosting(world)
    notes.set("trace", trace).set("caller span", span)
    const reply = await world.emulator(
      notes.get("fleet") ?? "",
      notes.get("emulator") ?? "",
      "GET",
      "/emails",
      {
        headers: { authorization: "Bearer re_vendor_key", traceparent: `00-${trace}-${span}-01` },
      },
    )
    expect(reply.status, reply.text).toBe(200)
  },
)

// ---- what the collector holds -------------------------------------------------------------

const remember = (state: Hosting, name: string, span: CollectorRow | undefined) => {
  state.notes.set(name, JSON.stringify(span ?? null))
}
const recall = (state: Hosting, name: string): CollectorRow =>
  JSON.parse(state.notes.get(name) ?? "null") as CollectorRow

Then(
  "the collector receives a server span {string} in that trace whose parent is the caller's span",
  async ({ world }, name: string) => {
    const state = hosting(world)
    const trace = state.notes.get("trace") ?? ""
    const [span] = await collector(state).waitFor("span", { operation_name: name, trace_id: trace })
    expect(span?.trace_id).toBe(trace)
    expect(span?.reference_parent_span_id).toBe(state.notes.get("caller span"))
    // OTLP span kind 2 is SERVER.
    expect(String(span?.span_kind)).toBe("2")
    expect(span?.span_id).toMatch(/^[0-9a-f]{16}$/)
    remember(state, "server span", span)
    remember(state, "span", span)
  },
)

Then(
  "that span records the request method, the path, a request id and the status {int}",
  async ({ world }, status: number) => {
    const span = recall(hosting(world), "span")
    expect(span.http_request_method).toBe("POST")
    expect(span.url_path).toBe("/api/v1/admin/users")
    expect(String(span.request_id)).toMatch(/^req_\w+$/)
    expect(span.http_response_status_code).toBe(status)
    expect(span.span_status).toBe("OK")
  },
)

Then(
  "the collector receives a span {string} inside that server span",
  async ({ world }, name: string) => {
    const state = hosting(world)
    const server = recall(state, "server span")
    const spans = await collector(state).waitFor("span", {
      operation_name: name,
      trace_id: server.trace_id,
    })
    const child = spans.find((span) => span.reference_parent_span_id === server.span_id)
    expect(child, JSON.stringify(spans)).toBeDefined()
    remember(state, "span", child)
  },
)

Then("that span names the emulator {string}", async ({ world }, target: string) => {
  const state = hosting(world)
  const span = recall(state, "span")
  expect(span.emulator_target).toBe(target)
  expect(span.emulator_name).toBe(target)
  expect(span.fleet_slug).toBe(state.notes.get("fleet"))
})

Then(
  "the collector receives a server span {string} with no parent",
  async ({ world }, name: string) => {
    const [span] = await collector(hosting(world)).waitFor("span", { operation_name: name })
    expect(span?.trace_id).toMatch(/^[0-9a-f]{32}$/)
    expect(span?.reference_parent_span_id ?? "").toBe("")
  },
)

Then("the collector receives a metrics export", async ({ world }) => {
  const target = collector(hosting(world))
  await expect
    .poll(async () => (await target.metrics()).metrics, { timeout: 15_000 })
    .toBeGreaterThan(0)
  expect((await target.metrics()).requests).toBeGreaterThan(0)
})

Then(
  "the collector receives an {string} log record from the service {string}",
  async ({ world }, severity: string, service: string) => {
    const [log] = await collector(hosting(world)).waitFor("log", { severity_text: severity })
    expect(log?.service_name).toBe(service)
    // The startup line: its attributes travel with the record.
    expect(log?.telemetry).toBe("otlp")
  },
)

Then(
  "every span at the collector comes from the service {string}",
  async ({ world }, service: string) => {
    const target = collector(hosting(world))
    await target.waitFor("span", { operation_name: "POST /api/*" })
    const spans = await target.spans()
    expect(spans.length).toBeGreaterThan(0)
    expect([...new Set(spans.map((span) => span.service_name))]).toEqual([service])
  },
)

Then(/^the server output does not contain "(.*)"$/, async ({ world }, text: string) => {
  expect(world.stack.server.output()).not.toContain(text)
})

// ---- shutdown and failure -----------------------------------------------------------------

When("the exporting server is stopped right away", async ({ world }) => {
  hosting(world).notes.set("exit", String(await world.stack.server.stop("SIGTERM")))
})

Then("the exporting server exited with code {int}", async ({ world }, code: number) => {
  expect(hosting(world).notes.get("exit"), world.stack.server.output()).toBe(String(code))
})

Then(
  "the collector already holds a span of the trace {string}",
  async ({ world }, trace: string) => {
    // No waiting: whatever was buffered had to be sent before the process exited.
    const spans = await collector(hosting(world)).spans({ trace_id: trace })
    expect(spans.map((span) => span.operation_name)).toContain("POST /api/*")
  },
)

Then(
  "the exporting server keeps answering {string} after an export interval has passed",
  async ({ world }, path: string) => {
    await sleep(EXPORT_INTERVAL_MS)
    expect((await fetch(`${world.url}${path}`)).status).toBe(200)
    expect(world.stack.server.child.exitCode).toBeNull()
    expect(world.stack.server.output()).not.toContain("unhandled")
  },
)

Then("the exporting server stops cleanly", async ({ world }) => {
  expect(await world.stack.server.stop("SIGTERM"), world.stack.server.output()).toBe(0)
})

Then("the collector has refused at least one export", async ({ world }) => {
  const target = collector(hosting(world))
  await expect
    .poll(async () => (await target.exports()).filter((request) => request.status === 503).length, {
      timeout: 15_000,
    })
    .toBeGreaterThan(0)
})

Then(
  "every line the server wrote is a JSON object with a time, a level and a message",
  async ({ world }) => {
    const lines = jsonLines(world.stack.server.output())
    expect(lines.length).toBeGreaterThan(0)
    for (const line of lines) {
      expect(line, world.stack.server.output()).toBeDefined()
      expect(Number.isNaN(Date.parse(String(line?.time)))).toBe(false)
      expect(["info", "warn", "error"]).toContain(line?.level)
      expect(typeof line?.message).toBe("string")
    }
  },
)

Then("no collector has received anything from that server", async ({ world }) => {
  await sleep(EXPORT_INTERVAL_MS)
  const target = collector(hosting(world))
  expect(await target.spans()).toEqual([])
  expect(await target.logs()).toEqual([])
  expect(await target.exports()).toEqual([])
})

// ---- secrets ------------------------------------------------------------------------------

When(
  "people sign in and call the API with an operator token, a personal token, a session and a rejected token",
  async ({ world }) => {
    const { secrets } = hosting(world)
    const issued = await world.must<{ token: { key: string } }>(
      "operator",
      "POST",
      "/admin/users",
      {
        email: world.email("grace"),
      },
    )
    const personal = issued.token.key
    const rejected = `mbf_u_${"d".repeat(20)}_${"D".repeat(43)}`
    const malformed = "not-a-key-but-still-a-secret-4e7a"
    const login = await fetch(`${world.url}/auth/token-login`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-mockingbird-csrf": "1" },
      body: JSON.stringify({ token: personal }),
    })
    const cookie = login.headers.get("set-cookie")?.split(";")[0] ?? ""
    expect(cookie).toContain("=")
    const dev = await world.person("Ada")
    for (const credential of [
      { kind: "key" as const, key: personal },
      { kind: "session" as const, cookie },
      dev,
      { kind: "key" as const, key: rejected },
      { kind: "key" as const, key: malformed },
    ])
      await world.api(credential, "GET", "/me")
    expect(world.last?.status).toBe(401)
    // A token mistakenly put in the URL must not be logged either.
    await fetch(`${world.url}/api/v1/me?token=${encodeURIComponent(personal)}`)
    for (const secret of [OPERATOR_TOKEN, personal, rejected, malformed]) secrets.add(secret)
    for (const session of [cookie, dev.kind === "session" ? dev.cookie : ""])
      secrets.add(session.slice(session.indexOf("=") + 1))
  },
)

Then("none of those credentials appear in the server output", async ({ world }) => {
  const { secrets } = hosting(world)
  expect(secrets.size).toBeGreaterThanOrEqual(6)
  const text = world.stack.server.output()
  expect(text).toContain("listening")
  for (const secret of secrets) expect(text).not.toContain(secret)
})

Then("none of those credentials appear in what the collector received", async ({ world }) => {
  const state = hosting(world)
  const target = collector(state)
  const spans = await target.spans()
  // The calls themselves did arrive, so this is not an empty collector passing by default.
  expect(spans.filter((span) => span.url_path === "/api/v1/me").length).toBeGreaterThanOrEqual(5)
  const received = JSON.stringify([spans, await target.logs(), await target.exports()])
  for (const secret of state.secrets) expect(received).not.toContain(secret)
})
