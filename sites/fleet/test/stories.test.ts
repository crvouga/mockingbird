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
import {
  matchRoute,
  ORG_TABS,
  orgTab,
  type Route,
  SCREENS,
  SHELL_STATES,
} from "../src/ui/routes.js"
import {
  DURABILITY,
  EMULATOR_STATES,
  emulatorState,
  FLEET_ACCESS,
} from "../src/ui/screens/fleet.js"
import { LIMIT_LABELS } from "../src/ui/screens/usage.js"
import type * as Api from "../src/ui/stories/fixtures.js"
import { type MockResponse, type MockRoutes, PENDING } from "../src/ui/stories/mock.js"
import { BOOT_MARKUP, INTERACTIONS, type Scenario, type Story } from "../src/ui/stories/story.js"
import { ROLES, SIGN_IN_METHODS } from "../src/ui/types.js"

const ui = join(import.meta.dir, "../src/ui")

type Loaded = { id: string; title: string; name: string; scenario: Scenario }

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
    expect(stories.length).toBeGreaterThan(40)
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

class Failure extends Error {
  constructor(readonly status: number) {
    super(`HTTP ${status}`)
  }
}

/**
 * The states a scenario puts on screen, worked out from its address and responses the way the
 * dashboard does: the same route table, the same tab table, the same state function.
 */
function statesOf({ path, routes, shows = [] }: Scenario): Set<string> {
  const states = new Set<string>(shows)
  const read = <T>(key: string): T => {
    const route = routes[key]
    if (!route || route === PENDING) throw new Failure(501)
    if (route.status >= 400) throw new Failure(route.status)
    return route.body as T
  }
  const list = <T>(name: string, key: string): T[] => {
    const { data } = read<{ data: T[] }>(key)
    states.add(`${name}:${data.length > 0 ? "populated" : "empty"}`)
    return data
  }

  const org = (id: string, tabName: string) => {
    const current = read<Api.Org>(`GET /orgs/${id}`)
    const admin = current.role === "admin" || current.role === "owner"
    const tab = orgTab(tabName)
    states.add("screen:org")
    if (current.suspended) {
      states.add("org:suspended")
      if (shows.includes("flash")) states.add("org:suspended:action-refused")
    }
    // A tab for admins tells anyone else so, without asking the API for it.
    if (ORG_TABS.find((entry) => entry.id === tab)?.admin && !admin) {
      states.add(`org-tab:${tab}:${current.role}:no-access`)
      return
    }
    if (tab === "projects") list("projects", `GET /orgs/${id}/projects`)
    if (tab === "members") {
      list("members", `GET /orgs/${id}/members`)
      if (admin) list("invites", `GET /orgs/${id}/invites`)
    }
    if (tab === "usage") {
      const report = read<Api.Usage>(`GET /orgs/${id}/usage`)
      const limits = report.limits as Record<string, number>
      const used = report.usage as Record<string, number>
      for (const [limit, , counted] of LIMIT_LABELS) {
        const max = limits[limit] ?? 0
        if (max === 0) states.add("usage:unlimited")
        else if (counted && (used[counted] ?? 0) >= max) states.add("usage:at-limit")
        else states.add("usage:within-limit")
      }
      states.add(report.daily.length > 0 ? "usage:requests" : "usage:no-requests")
    }
    if (tab === "keys") {
      const keys = list<Api.ApiKey>("keys", `GET /orgs/${id}/api-keys`)
      read(`GET /orgs/${id}/projects`)
      if (keys.some((key) => key.projectId)) states.add("keys:project-scoped")
      if (keys.some((key) => key.expiresAt)) states.add("keys:expiring")
      if (keys.some((key) => !key.lastUsedAt)) states.add("keys:never-used")
    }
    if (tab === "audit") list("audit", `GET /orgs/${id}/audit`)
    states.add(`org-tab:${tab}`).add(`org-tab:${tab}:${current.role}`)
  }

  const screens: Record<Route["screen"], (route: Route, me: Api.Me) => void> = {
    home: (_route, me) => {
      if (me.orgs[0] && path === "/") {
        org(me.orgs[0].id, "projects")
        states.add("screen:home:opens-first-organization")
        return
      }
      states.add("screen:home").add(`orgs:${me.orgs.length > 0 ? "populated" : "empty"}`)
      if (me.orgs.some((entry) => entry.suspended)) states.add("orgs:suspended")
    },
    org: (route) => org(route.id, route.tab),
    project: (route) => {
      const project = read<Api.Project>(`GET /projects/${route.id}`)
      let role = "no-organization"
      try {
        role = read<Api.Org>(`GET /orgs/${project.orgId}`).role ?? role
      } catch {}
      list("fleets", `GET /projects/${route.id}/fleets`)
      states.add("screen:project").add(`project:${role}`)
    },
    fleet: (route) => {
      const fleet = read<Api.Fleet>(`GET /fleets/${route.id}`)
      read(`GET /projects/${fleet.projectId}`)
      let role = "no-organization"
      try {
        role = read<Api.Org>(`GET /orgs/${fleet.orgId}`).role ?? role
      } catch {}
      read("GET /catalog")
      states.add("screen:fleet").add(`fleet:${role}`).add(`access:${fleet.access}`)
      states.add(fleet.requestsPerMinute ? "rate:custom" : "rate:organization-ceiling")
      const emulators = Object.entries(fleet.emulators)
      if (emulators.length === 0) states.add("emulators:empty")
      for (const [name, emulator] of emulators) {
        states.add(`durability:${emulator.durability}`).add(`emulator:${emulatorState(emulator)}`)
        if (name !== emulator.target) states.add("emulator:second-instance")
      }
    },
    account: () => {
      list("tokens", "GET /tokens")
      states.add("screen:account")
    },
    "api-reference": () => {
      read("GET /api/openapi.json")
      states.add("screen:api-reference")
    },
    invite: () => {
      read("POST /invites/accept")
      states.add("screen:invite")
    },
  }

  let me: Api.Me
  try {
    me = read<Api.Me>("GET /me")
  } catch (error) {
    if (routes["GET /me"] === PENDING) return states.add("shell:boot")
    if ((error as Failure).status !== 401) return states.add("shell:unavailable")
    let auth: Api.Config["auth"]
    try {
      auth = read<Api.Config>("GET /config").auth
    } catch {
      return states.add("shell:unavailable")
    }
    states.add("shell:sign-in")
    for (const method of SIGN_IN_METHODS) if (auth[method]) states.add(`sign-in:${method}`)
    if (shows.includes("flash")) states.add("sign-in:refused")
    return states
  }
  try {
    const route = matchRoute(path)
    screens[route.screen](route, me)
  } catch (error) {
    const { status } = error as Failure
    states.add(
      status === 404 ? "shell:not-found" : status === 403 ? "shell:forbidden" : "shell:error",
    )
  }
  return states
}

/** Everything that must have a story. The tables are the UI's own, so a new entry needs one. */
const required = [
  ...SHELL_STATES.map((state) => `shell:${state}`),
  ...SCREENS.map((screen) => `screen:${screen}`),
  ...ORG_TABS.map((tab) => `org-tab:${tab.id}`),
  // Each tab as each role that is shown it.
  ...ORG_TABS.flatMap((tab) =>
    ROLES.filter((role) => !tab.admin || role === "admin" || role === "owner").map(
      (role) => `org-tab:${tab.id}:${role}`,
    ),
  ),
  // Each admin tab as each role that is refused it.
  ...ORG_TABS.filter((tab) => tab.admin).flatMap((tab) =>
    ROLES.filter((role) => role !== "admin" && role !== "owner").map(
      (role) => `org-tab:${tab.id}:${role}:no-access`,
    ),
  ),
  ...SIGN_IN_METHODS.map((method) => `sign-in:${method}`),
  "sign-in:refused",
  ...ROLES.map((role) => `project:${role}`),
  ...ROLES.map((role) => `fleet:${role}`),
  "fleet:no-organization",
  ...Object.keys(DURABILITY).map((mode) => `durability:${mode}`),
  ...EMULATOR_STATES.map((state) => `emulator:${state}`),
  ...FLEET_ACCESS.map(([access]) => `access:${access}`),
  ...INTERACTIONS,
  "members:populated",
  ...["orgs", "projects", "invites", "keys", "audit", "fleets", "tokens"].flatMap((name) => [
    `${name}:empty`,
    `${name}:populated`,
  ]),
  "screen:home:opens-first-organization",
  "orgs:suspended",
  "org:suspended",
  "org:suspended:action-refused",
  "usage:within-limit",
  "usage:at-limit",
  "usage:unlimited",
  "usage:requests",
  "usage:no-requests",
  "keys:project-scoped",
  "keys:expiring",
  "keys:never-used",
  "project:no-organization",
  "rate:custom",
  "rate:organization-ceiling",
  "emulators:empty",
  "emulator:second-instance",
]

describe("story coverage", () => {
  const shown = new Map<string, string[]>()
  for (const story of stories)
    for (const state of statesOf(story.scenario))
      shown.set(state, [...(shown.get(state) ?? []), story.id])

  test("every screen, tab and state has a story", () => {
    expect(required.filter((state) => !shown.has(state))).toEqual([])
  })

  test("every story shows a state that is accounted for", () => {
    const unknown = [...shown.keys()].filter((state) => !required.includes(state))
    expect(unknown).toEqual([])
    expect(stories.filter((story) => statesOf(story.scenario).size === 0)).toEqual([])
  })

  test("a story that claims an interaction performs one the API answers for", () => {
    for (const { id, scenario } of stories) {
      const shows = scenario.shows ?? []
      const served = responses(scenario.routes).filter(([key]) => !key.startsWith("GET "))
      if (shows.length > 0) expect(scenario.steps, id).toBeDefined()
      if (shows.includes("flash"))
        expect(
          served.some(([, response]) => response.status >= 400),
          id,
        ).toBe(true)
      if (shows.some((state) => state.startsWith("secret:")))
        expect(
          served.some(([, response]) => response.status === 201),
          id,
        ).toBe(true)
    }
  })

  test("a route or tab without a story would fail", () => {
    const without = (title: string) =>
      new Set(
        stories
          .filter((story) => story.title !== title)
          .flatMap((story) => [...statesOf(story.scenario)]),
      )
    expect(without("Account").has("screen:account")).toBe(false)
    expect(without("Organization/Audit log").has("org-tab:audit")).toBe(false)
    expect(required).toContain("screen:account")
    expect(required).toContain("org-tab:audit")
  })

  test("the address of every story is one the router knows", () => {
    for (const { scenario } of stories) expect(SCREENS).toContain(matchRoute(scenario.path).screen)
  })

  test("stories start from the markup index.html ships", async () => {
    const page = await Bun.file(join(ui, "index.html")).text()
    expect(page).toContain(`<div id="app">${BOOT_MARKUP}</div>`)
  })
})
