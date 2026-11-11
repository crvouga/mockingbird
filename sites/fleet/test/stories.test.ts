/**
 * Storybook is the dashboard's catalogue of screens. These tests keep it honest without a browser:
 * every response a story serves matches the OpenAPI contract, and every screen, tab and state the
 * UI declares is shown by at least one story.
 */
import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import { storyNameFromExport, toId } from "storybook/internal/csf"
import openapi from "../openapi.json" with { type: "json" }
import { SCHEMAS, type Schema, validate } from "../src/openapi.js"
import { matchRoute, ROUTES, type RouteDef, type RouteId } from "../src/ui/routes.js"
import { type MockResponse, type MockRoutes, PENDING } from "../src/ui/stories/mock.js"
import {
  BOOT_MARKUP,
  INTERACTIONS,
  type Interaction,
  type Scenario,
  type Story,
} from "../src/ui/stories/story.js"

const ui = join(import.meta.dir, "../src/ui")

type Loaded = { id: string; title: string; name: string; kind: string; scenario: Scenario }

const stories: Loaded[] = []
for (const file of [...new Bun.Glob("*.stories.ts").scanSync(join(ui, "stories"))].sort()) {
  const { default: meta, ...exported } = (await import(join(ui, "stories", file))) as {
    default: { title: string }
  } & Record<string, unknown>
  for (const [key, story] of Object.entries(exported as Record<string, Story>))
    stories.push({
      id: toId(meta.title, storyNameFromExport(key)),
      title: meta.title,
      name: storyNameFromExport(key),
      kind: story.parameters.kind,
      scenario: story.parameters.scenario,
    })
}

// ---- the contract ------------------------------------------------------------------------

type Operation = { responses: Record<string, { content?: Record<string, { schema: Schema }> }> }
const operations = Object.entries(openapi.paths).flatMap(([template, item]) =>
  Object.entries(item as Record<string, Operation>).map(([method, operation]) => ({
    method: method.toUpperCase(),
    template,
    pattern: new RegExp(`^${template.replace(/\{[^}]+\}/g, "[^/]+")}$`),
    operation,
  })),
)

/** The operation a mocked request is for; a literal path wins over a parameterised one. */
function operationFor(method: string, path: string) {
  const matches = operations.filter((entry) => entry.method === method && entry.pattern.test(path))
  return matches.find((entry) => entry.template === path) ?? matches[0]
}

/** Every response a scenario can serve, including the ones a call swaps in. */
function responses(routes: MockRoutes): [string, MockResponse][] {
  return Object.entries(routes).flatMap(([key, route]) =>
    route === PENDING
      ? []
      : [[key, route] as [string, MockResponse], ...responses(route.then ?? {})],
  )
}

function contractProblems(key: string, response: MockResponse): string[] {
  const [method = "", path = ""] = key.split(" ")
  if (response.status >= 400) return validate(SCHEMAS.Error as Schema, response.body)
  if (key === "GET /api/openapi.json")
    return Bun.deepEquals(response.body, openapi) ? [] : ["is not the committed openapi.json"]
  if (path.startsWith("/auth/"))
    return method === "POST" ? validate(SCHEMAS.Ok as Schema, response.body) : ["is not a POST"]
  const operation = operationFor(method, path)?.operation
  if (!operation) return ["is not an operation of the API"]
  const schema = operation.responses[String(response.status)]?.content?.["application/json"]?.schema
  if (!schema) return [`answers ${response.status}, which the operation does not declare`]
  return validate(schema, response.body)
}

describe("story fixtures", () => {
  test("there are stories, with unique ids", () => {
    expect(stories.length).toBeGreaterThan(ROUTES.length)
    expect(new Set(stories.map((story) => story.id)).size).toBe(stories.length)
  })

  for (const story of stories)
    test(`${story.title} / ${story.name} serves responses the API could send`, () => {
      const problems = responses(story.scenario.routes).flatMap(([key, response]) =>
        contractProblems(key, response).map((problem) => `${key}: ${problem}`),
      )
      expect(problems).toEqual([])
    })

  test("a response that breaks the contract is caught", () => {
    const org = { id: "org_acme", slug: "Not A Slug", name: "Acme", suspended: null }
    expect(contractProblems("GET /orgs/org_acme", { status: 200, body: org })).not.toEqual([])
    expect(contractProblems("GET /nowhere", { status: 200, body: {} })).not.toEqual([])
    expect(contractProblems("POST /orgs", { status: 200, body: {} })).not.toEqual([])
  })
})

// ---- coverage ----------------------------------------------------------------------------
//
// The rendered side of these rules (that a story really draws the route and state it claims, that
// every route and shell state is drawn by some story, and that every surface passes `auditSurface`)
// is checked in a real browser by `scripts/storybook-screenshots.ts`.

/** The route a story opens on. */
const routeOf = (scenario: Scenario): RouteDef | undefined =>
  matchRoute(scenario.path.split("?")[0] ?? "")?.route

/** What a mutation route must be shown doing, each in at least one story. */
export function requiredStates(route: RouteDef): (Interaction | "idle")[] {
  if (route.kind !== "mutation") return []
  return [
    "idle",
    "pending",
    "form-error",
    ...(route.fields && route.fields.length > 0 ? (["field-error"] as const) : []),
    route.result ? "secret" : "landed",
  ]
}

/** Routes without a story, and mutation states without one; empty when coverage is complete. */
export function coverageGaps(loaded: readonly Pick<Loaded, "kind" | "scenario">[]): string[] {
  const shown = new Map<RouteId, Set<string>>()
  for (const { kind, scenario } of loaded) {
    const route = routeOf(scenario)
    if (!route) continue
    const states = shown.get(route.id) ?? new Set<string>()
    shown.set(route.id, states)
    states.add("any")
    // Idle: opened on its form, as a mutation, with nothing done to it yet.
    if (kind === "mutation" && !scenario.steps) states.add("idle")
    for (const state of scenario.shows ?? []) states.add(state)
  }
  const gaps: string[] = []
  for (const route of ROUTES as readonly RouteDef[]) {
    const states = shown.get(route.id)
    if (!states) {
      gaps.push(`${route.id} (${route.path}) has no story`)
      continue
    }
    for (const state of requiredStates(route))
      if (!states.has(state)) gaps.push(`${route.id} has no story showing it ${state}`)
  }
  return gaps
}

describe("story coverage", () => {
  test("every route has a story, and every mutation is shown idle, pending, refused and done", () => {
    expect(coverageGaps(stories)).toEqual([])
  })

  test("every route declares its kind", () => {
    for (const route of ROUTES as readonly RouteDef[])
      expect(["query", "mutation"]).toContain(route.kind)
  })

  test("a missing route or state would fail", () => {
    const without = (id: string) => stories.filter((story) => routeOf(story.scenario)?.id !== id)
    expect(coverageGaps(without("fleet.rename"))).toContain(
      "fleet.rename (/fleets/:fleet/rename) has no story",
    )
    const noPending = stories.filter(
      (story) =>
        !(routeOf(story.scenario)?.id === "org.new" && story.scenario.shows?.includes("pending")),
    )
    expect(coverageGaps(noPending)).toContain("org.new has no story showing it pending")
  })

  test("a story that claims a state acts to reach it", () => {
    for (const story of stories)
      if ((story.scenario.shows ?? []).length > 0)
        expect(story.scenario.steps, `${story.id} claims a state without steps`).toBeDefined()
  })

  test("claimed states are ones the stories know", () => {
    for (const story of stories)
      for (const state of story.scenario.shows ?? []) expect(INTERACTIONS).toContain(state)
  })

  test("the address of every story is one the router knows, or a deliberate miss", () => {
    const unknown = stories.filter((story) => !routeOf(story.scenario)).map((story) => story.id)
    // A page-not-found story opens on an address no route answers; that is its point.
    for (const id of unknown) expect(id).toMatch(/not-found/)
  })

  test("a story opened on a mutation route as a mutation is one the route declares", () => {
    for (const story of stories) {
      const route = routeOf(story.scenario)
      if (story.kind === "mutation")
        expect(route?.kind, `${story.id} is a mutation story on a ${route?.kind}`).toBe("mutation")
    }
  })

  test("stories start from the markup index.html ships", async () => {
    const index = await Bun.file(join(ui, "index.html")).text()
    expect(index).toContain(BOOT_MARKUP)
  })
})
