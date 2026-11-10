/** Tenancy and access: the API contract and the rest of the surface another application integrates with. */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { expect } from "@playwright/test"
import { PACKAGE_ROOT } from "../support/stack.js"
import { bodyOf, phrase, send } from "../support/tenancy.js"
import type { World } from "../support/world.js"
import { Then, When } from "./common.steps.js"

type Operation = { operationId: string; requestBody?: unknown; security?: unknown[] }
type Document = {
  openapi: string
  servers: { url: string }[]
  paths: Record<string, Record<string, Operation>>
}

/** `"GET /api/v1/me"` as a method and a path. */
const parse = (request: string) => {
  const [method = "GET", path = "/"] = request.split(" ")
  return { method, path }
}

const header = (world: World, name: string) => world.last?.headers.get(name) ?? null

const document = (world: World) => {
  expect(world.last?.status, world.last?.text).toBe(200)
  return world.last?.body as Document
}

const operations = (doc: Document) =>
  Object.entries(doc.paths).flatMap(([path, item]) =>
    Object.entries(item).map(([method, operation]) => ({
      name: `${method.toUpperCase()} ${path}`,
      method: method.toUpperCase(),
      path,
      operation,
    })),
  )

// ---- requests ------------------------------------------------------------------------------

When(phrase("an API client sends {string}"), async ({ world }, request: string) => {
  const { method, path } = parse(request)
  await send(world, method, path)
})

When(
  phrase("an API client sends {string} with the request id {string}"),
  async ({ world }, request: string, id: string) => {
    const { method, path } = parse(request)
    await send(world, method, path, { headers: { "x-request-id": id } })
  },
)

When(
  phrase("a browser on {string} asks permission to call the API"),
  async ({ world }, origin: string) => {
    await send(world, "OPTIONS", "/api/v1/orgs", {
      headers: { origin, "access-control-request-method": "POST" },
    })
  },
)

When(
  phrase("a browser on {string} sends {string}"),
  async ({ world }, origin: string, request: string) => {
    const { method, path } = parse(request)
    await send(world, method, path, { headers: { origin } })
  },
)

When(
  phrase("{person} sends an organization with a malformed slug and an unrecognised field"),
  async ({ world }, person: string) => {
    await world.api(person, "POST", "/orgs", { name: "Acme", slug: "Not A Slug", plan: "pro" })
  },
)

const BAD_BODIES: Record<string, () => string> = {
  "not JSON": () => "{name: Acme",
  "a JSON list": () => '[{"name":"Acme"}]',
  "larger than 1 MiB": () => JSON.stringify({ name: "x".repeat(1024 * 1024 + 1) }),
}

When(
  phrase(
    "{person} sends a body that is {options} to create an organization",
    Object.keys(BAD_BODIES),
  ),
  async ({ world }, person: string, what: string) => {
    await send(world, "POST", "/api/v1/orgs", {
      as: await world.person(person),
      headers: { "content-type": "application/json" },
      body: BAD_BODIES[what]?.() ?? "",
    })
  },
)

// ---- the OpenAPI document ------------------------------------------------------------------

Then(phrase("the document declares OpenAPI {string}"), async ({ world }, version: string) => {
  expect(document(world).openapi).toBe(version)
})

Then(phrase("the document's server is this server's {string}"), async ({ world }, path: string) => {
  expect(document(world).servers).toEqual([{ url: `${world.url}${path}` }])
})

Then(
  "the document matches the committed contract, apart from the server address",
  async ({ world }) => {
    const committed = JSON.parse(
      readFileSync(join(PACKAGE_ROOT, "openapi.json"), "utf8"),
    ) as Document
    expect(committed.servers[0]?.url).toMatch(/^https:\/\/.+\/api\/v1$/)
    expect({ ...document(world), servers: [] }).toEqual({ ...committed, servers: [] })
  },
)

Then("no two operations in the document share an id", async ({ world }) => {
  const ids = operations(document(world)).map((entry) => entry.operation.operationId)
  expect(ids.length).toBeGreaterThan(30)
  expect(new Set(ids).size).toBe(ids.length)
  for (const id of ids) expect(id).toMatch(/^[a-z][A-Za-z]+$/)
})

Then("every operation in the document is routed by the server", async ({ world }) => {
  for (const entry of operations(document(world))) {
    const path = `/api/v1${entry.path.replace(/\{\w+\}/g, "anything")}`
    const reply = await send(world, entry.method, path, {
      ...(entry.operation.requestBody ? { body: {} } : {}),
    })
    // Public operations answer; every other one asks for a credential. None is unknown.
    const expected =
      Array.isArray(entry.operation.security) && entry.operation.security.length === 0 ? 200 : 401
    expect(reply.status, `${entry.name}: ${reply.text.slice(0, 200)}`).toBe(expected)
  }
})

Then("the document lists exactly the operations the agent guide lists", async ({ world }) => {
  const documented = operations(document(world))
    .map((entry) => entry.name)
    .sort()
  const guide = await send(world, "GET", "/llms.txt")
  const guided = [...guide.text.matchAll(/^- (GET|POST|PUT|PATCH|DELETE) (\/\S*) — /gm)]
    .map((match) => `${match[1]} ${match[2]}`)
    .sort()
  expect(guided.length).toBeGreaterThan(30)
  expect(documented).toEqual(guided)
})

Then(phrase("the document has the operation {string}"), async ({ world }, name: string) => {
  expect(operations(document(world)).map((entry) => entry.name)).toContain(name)
})

// ---- public endpoints ----------------------------------------------------------------------

Then(
  "the configuration names this server's address, its sign-in methods and the durability modes",
  async ({ world }) => {
    expect(world.last?.body).toEqual({
      publicUrl: world.url,
      fleetUrl: world.url,
      auth: { oidc: false, devLogin: true, tokenLogin: true },
      durability: ["strict", "buffered", "ephemeral"],
    })
  },
)

type CatalogEntry = Record<string, string>
const catalog = (world: World) => bodyOf<{ data: CatalogEntry[] }>(world).data

Then(phrase("the catalog offers {string}"), async ({ world }, target: string) => {
  expect(catalog(world).map((entry) => entry.target)).toContain(target)
})

Then(phrase("the catalog does not offer {string}"), async ({ world }, target: string) => {
  expect(catalog(world).length).toBeGreaterThan(50)
  expect(catalog(world).map((entry) => entry.target)).not.toContain(target)
})

Then(
  "every catalog entry has a target, a package, a display name, a category and a description",
  async ({ world }) => {
    expect(catalog(world).length).toBeGreaterThan(50)
    for (const entry of catalog(world))
      for (const field of ["target", "package", "displayName", "category", "description"])
        expect(entry[field], `${entry.target}.${field}`).toEqual(expect.any(String))
    const targets = catalog(world).map((entry) => entry.target)
    expect(new Set(targets).size).toBe(targets.length)
  },
)

// ---- errors --------------------------------------------------------------------------------

Then("the API reply is an error envelope with a code and a message", async ({ world }) => {
  expect(header(world, "content-type")).toContain("application/json")
  const body = world.last?.body as { error: Record<string, unknown> }
  expect(Object.keys(body)).toEqual(["error"])
  expect(body.error.code).toMatch(/^[a-z_]+$/)
  expect(typeof body.error.message).toBe("string")
  expect((body.error.message as string).length).toBeGreaterThan(0)
  for (const key of Object.keys(body.error)) expect(["code", "message", "details"]).toContain(key)
})

Then(
  phrase("the error details are a list of {int} problems, the first of which is the message"),
  async ({ world }, count: string) => {
    const { error } = bodyOf<{ error: { message: string; details: string[] } }>(world)
    expect(error.details).toHaveLength(Number(count))
    expect(error.details[0]).toBe(error.message)
    expect(error.details.join("\n")).toContain("body.slug")
    expect(error.details.join("\n")).toContain("body.plan: unknown field")
  },
)

// ---- request ids ---------------------------------------------------------------------------

Then("the API reply carries a generated request id", async ({ world }) => {
  expect(header(world, "x-request-id")).toMatch(/^req_[a-z0-9]{16}$/)
})

Then(phrase("the API reply carries the request id {string}"), async ({ world }, id: string) => {
  expect(header(world, "x-request-id")).toBe(id)
})

// ---- cross-origin access -------------------------------------------------------------------

Then(phrase("the API allows the origin {string}"), async ({ world }, origin: string) => {
  expect(header(world, "access-control-allow-origin")).toBe(origin)
  expect(header(world, "vary")?.toLowerCase()).toContain("origin")
})

Then(phrase("the API allows the headers {string}"), async ({ world }, headers: string) => {
  expect(header(world, "access-control-allow-headers")).toBe(headers)
  expect(header(world, "access-control-allow-methods")).toBe("GET, POST, PUT, PATCH, DELETE")
})

Then("the API does not allow cookies from other origins", async ({ world }) => {
  expect(header(world, "access-control-allow-credentials")).toBeNull()
})

Then("the page may read the request id and rate-limit headers", async ({ world }) => {
  const exposed = header(world, "access-control-expose-headers") ?? ""
  for (const name of ["x-request-id", "ratelimit-limit", "ratelimit-remaining", "retry-after"])
    expect(exposed).toContain(name)
})

Then("the API allows no origin", async ({ world }) => {
  for (const name of [
    "access-control-allow-origin",
    "access-control-allow-headers",
    "access-control-allow-methods",
    "access-control-allow-credentials",
  ])
    expect(header(world, name), name).toBeNull()
})

// ---- the agent guide -----------------------------------------------------------------------

Then("the guide is plain text", async ({ world }) => {
  expect(header(world, "content-type")).toBe("text/plain; charset=utf-8")
  expect(world.last?.text.startsWith("# Mockingbird Fleet")).toBe(true)
})

Then("the guide gives this server's API base and OpenAPI address", async ({ world }) => {
  expect(world.last?.text).toContain(`API base: ${world.url}/api/v1`)
  expect(world.last?.text).toContain(`OpenAPI 3.1: ${world.url}/api/openapi.json`)
})

Then(phrase("the guide mentions {string}"), async ({ world }, text: string) => {
  expect(world.last?.text).toContain(text)
})
