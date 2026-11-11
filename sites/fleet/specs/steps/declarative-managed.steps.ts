/**
 * Steps for organizations managed by a `mockingbird.yaml`: what can no longer be changed by
 * hand and what still can, releasing an organization, and exporting any organization as a file.
 */
import { expect } from "@playwright/test"
import type { DataTable } from "playwright-bdd"
import {
  ACTOR,
  actor,
  declaredOperations,
  type Exported,
  fill,
  orgNamed,
  PERSON,
  parseYaml,
  plain,
  remember,
  sendFile,
  state,
  theFile,
  writeDeclaration,
} from "../support/declarative.js"
import type { FleetView } from "../support/fleets.js"
import { join } from "../support/tenancy.js"
import type { World } from "../support/world.js"
import { Given, Then, When } from "./common.steps.js"

const step = (pattern: string) => new RegExp(`^${pattern}$`)

/** What a scenario about a managed organization acts on: the first of each thing it declared. */
function declared(world: World) {
  const things = [...world.things.values()] as { id?: unknown }[]
  const find = (prefix: string) => {
    const found = things.find(
      (thing) => typeof thing.id === "string" && thing.id.startsWith(prefix),
    )
    if (!found) throw new Error(`The scenario has applied nothing with an id starting "${prefix}"`)
    return found.id as string
  }
  const fleet = things.find(
    (thing) => typeof thing.id === "string" && thing.id.startsWith("flt_"),
  ) as FleetView | undefined
  return {
    org: find("org_"),
    project: find("prj_"),
    fleet: find("flt_"),
    emulator: Object.keys(fleet?.emulators ?? {})[0] ?? "resend",
  }
}

type Request = { operation: string; method: string; path: string; body?: unknown }

/** Every way to change by hand what a file declares, as the API operation that does it. */
const HAND_EDITS: Record<string, (ids: ReturnType<typeof declared>) => Request> = {
  "rename the organization": ({ org }) => ({
    operation: "updateOrg",
    method: "PATCH",
    path: `/orgs/${org}`,
    body: { name: "Renamed by hand" },
  }),
  "add a project": ({ org }) => ({
    operation: "createProject",
    method: "POST",
    path: `/orgs/${org}/projects`,
    body: { name: "Made by hand" },
  }),
  "rename a project": ({ project }) => ({
    operation: "updateProject",
    method: "PATCH",
    path: `/projects/${project}`,
    body: { name: "Renamed by hand" },
  }),
  "delete a project": ({ project }) => ({
    operation: "deleteProject",
    method: "DELETE",
    path: `/projects/${project}`,
  }),
  "add a fleet": ({ project }) => ({
    operation: "createFleet",
    method: "POST",
    path: `/projects/${project}/fleets`,
    body: { name: "Made by hand" },
  }),
  "change a fleet's access": ({ fleet }) => ({
    operation: "updateFleet",
    method: "PATCH",
    path: `/fleets/${fleet}`,
    body: { access: "key" },
  }),
  "delete a fleet": ({ fleet }) => ({
    operation: "deleteFleet",
    method: "DELETE",
    path: `/fleets/${fleet}`,
  }),
  "add an emulator": ({ fleet }) => ({
    operation: "putEmulator",
    method: "PUT",
    path: `/fleets/${fleet}/emulators/byhand`,
    body: { target: "stripe" },
  }),
  "change an emulator's durability": ({ fleet, emulator }) => ({
    operation: "updateEmulator",
    method: "PATCH",
    path: `/fleets/${fleet}/emulators/${emulator}`,
    body: { durability: "ephemeral" },
  }),
  "remove an emulator": ({ fleet, emulator }) => ({
    operation: "deleteEmulator",
    method: "DELETE",
    path: `/fleets/${fleet}/emulators/${emulator}`,
  }),
}

When(
  step(`${ACTOR} tries by hand to (${Object.keys(HAND_EDITS).join("|")})`),
  async ({ world }, words: string, change: string) => {
    const request = (HAND_EDITS[change] as (typeof HAND_EDITS)[string])(declared(world))
    world.things.set("@hand-edit", request)
    await world.api(actor(world, words), request.method, request.path, request.body)
  },
)

Then("that was the API operation {string}", async ({ world }, operation: string) => {
  const request = world.thing<Request>("@hand-edit")
  expect(request.operation).toBe(operation)
  // The operation id is the one the published contract gives this method and path.
  const document = (await (await fetch(`${world.url}/api/openapi.json`)).json()) as {
    paths: Record<string, Record<string, { operationId?: string }>>
  }
  const matches = Object.entries(document.paths).flatMap(([template, methods]) =>
    new RegExp(`^${template.replace(/\{[^}]+\}/g, "[^/]+")}$`).test(request.path)
      ? [methods[request.method.toLowerCase()]?.operationId]
      : [],
  )
  expect(matches).toContain(operation)
})

Then("the refusal says how to change it instead", async ({ world }) => {
  expect(world.last?.status, world.last?.text).toBe(409)
  const message = world.errorMessage ?? ""
  expect(message).toContain("configured by mockingbird.yaml")
  expect(message).toContain("Change the file and apply it (PUT /api/v1/manifest)")
  expect(message).toContain(`DELETE /api/v1/orgs/${declared(world).org}/manifest`)
})

Then("the changes only a file may make are exactly:", async ({ world }, table: DataTable) => {
  const operations = table
    .raw()
    .map(([operation]) => operation as string)
    .sort()
  // Every one of them is specified by a row of the outline above…
  expect(
    Object.values(HAND_EDITS)
      .map((request) => request(declared(world)).operation)
      .sort(),
  ).toEqual(operations)
  // …and they are the whole set the server refuses.
  expect(declaredOperations().sort()).toEqual(operations)
})

/** What stays available by hand in a managed organization; each resolves to the reply's status. */
const OPERATIONS: Record<string, (world: World, who: string) => Promise<number>> = {
  "reset an emulator": async (world, who) => {
    const { fleet, emulator } = declared(world)
    return (await world.api(who, "POST", `/fleets/${fleet}/emulators/${emulator}/reset`)).status
  },
  "save an emulator's state": async (world, who) => {
    const { fleet, emulator } = declared(world)
    return (await world.api(who, "POST", `/fleets/${fleet}/emulators/${emulator}/flush`)).status
  },
  "download an emulator's state": async (world, who) => {
    const { fleet, emulator } = declared(world)
    return (await world.api(who, "GET", `/fleets/${fleet}/emulators/${emulator}/state`)).status
  },
  "invite a teammate": async (world, who) =>
    (
      await world.api(who, "POST", `/orgs/${declared(world).org}/invites`, {
        email: world.email("Newcomer"),
      })
    ).status,
  "change a member's role": async (world, who) => {
    const org = [...world.things.entries()].find(([, thing]) => thing.id === declared(world).org)
    await join(world, "Teammate", org?.[0] as string, "member")
    const { user } = await world.must<{ user: { id: string } }>("Teammate", "GET", "/me")
    return (
      await world.api(who, "PATCH", `/orgs/${declared(world).org}/members/${user.id}`, {
        role: "admin",
      })
    ).status
  },
  "remove a member": async (world, who) => {
    const org = [...world.things.entries()].find(([, thing]) => thing.id === declared(world).org)
    await join(world, "Teammate", org?.[0] as string, "member")
    const { user } = await world.must<{ user: { id: string } }>("Teammate", "GET", "/me")
    return (await world.api(who, "DELETE", `/orgs/${declared(world).org}/members/${user.id}`))
      .status
  },
  "make an API key": async (world, who) =>
    (await world.api(who, "POST", `/orgs/${declared(world).org}/api-keys`, { name: "ci" })).status,
  "revoke an API key": async (world, who) => {
    const { org } = declared(world)
    const key = await world.must<{ id: string }>(who, "POST", `/orgs/${org}/api-keys`, {
      name: "old",
    })
    return (await world.api(who, "DELETE", `/orgs/${org}/api-keys/${key.id}`)).status
  },
  "read the audit log": async (world, who) =>
    (await world.api(who, "GET", `/orgs/${declared(world).org}/audit`)).status,
  "delete the organization": async (world, who) =>
    (await world.api(who, "DELETE", `/orgs/${declared(world).org}`)).status,
}

Then(
  step(`${ACTOR} can still (${Object.keys(OPERATIONS).join("|")})`),
  async ({ world }, words: string, operation: string) => {
    const status = await (OPERATIONS[operation] as (typeof OPERATIONS)[string])(
      world,
      actor(world, words),
    )
    expect(status, world.last?.text).toBeGreaterThanOrEqual(200)
    expect(status, world.last?.text).toBeLessThan(300)
  },
)

// ---- releasing -----------------------------------------------------------------------------

When(
  step(`${ACTOR} releases the organization "([^"]*)" from its file`),
  async ({ world }, words: string, org: string) => {
    await world.api(actor(world, words), "DELETE", `/orgs/${orgNamed(world, org).id}/manifest`)
  },
)

Given(
  step(`${ACTOR} has released the organization "([^"]*)" from its file`),
  async ({ world }, words: string, org: string) => {
    await world.must(actor(world, words), "DELETE", `/orgs/${orgNamed(world, org).id}/manifest`)
  },
)

// ---- configuring by hand, exporting, adopting ----------------------------------------------

const titled = (slug: string) => `${slug.charAt(0).toUpperCase()}${slug.slice(1)}`

/**
 * An organization made one API call at a time, the way it is done without a file. One row per
 * emulator; a project or a fleet is made the first time a row names it, and is called by its
 * slug with a capital letter.
 */
Given(
  step(`${PERSON} has configured the organization "([^"]*)" by hand:`),
  async ({ world }, person: string, org: string, table: DataTable) => {
    const who = actor(world, person)
    const made = await world.must<{ id: string }>(who, "POST", "/orgs", {
      name: titled(org),
      slug: world.slug(org),
    })
    const projects = new Map<string, string>()
    const fleets = new Map<string, Record<string, unknown>>()
    for (const row of table.hashes()) {
      const project = row.project as string
      if (!projects.has(project))
        projects.set(
          project,
          (
            await world.must<{ id: string }>(who, "POST", `/orgs/${made.id}/projects`, {
              name: titled(project),
              slug: project,
            })
          ).id,
        )
      if (!row.fleet) continue
      const fleet = fleets.get(row.fleet) ?? {
        project: projects.get(project),
        name: titled(row.fleet),
        slug: world.slug(row.fleet),
        access: row.access || "open",
        ...(row["requests per minute"]
          ? { requestsPerMinute: Number(row["requests per minute"]) }
          : {}),
        emulators: {},
      }
      if (row.emulator)
        (fleet.emulators as Record<string, unknown>)[row.emulator] = {
          target: row.target || row.emulator,
          ...(row.durability ? { durability: row.durability } : {}),
        }
      fleets.set(row.fleet, fleet)
    }
    for (const { project, ...fleet } of fleets.values())
      await world.must(who, "POST", `/projects/${project}/fleets`, fleet)
    await remember(world, who, made.id)
  },
)

When(
  step(`${ACTOR} exports the organization "([^"]*)" as a mockingbird\\.yaml`),
  async ({ world }, words: string, org: string) => {
    const reply = await world.api(
      actor(world, words),
      "GET",
      `/orgs/${orgNamed(world, org).id}/manifest`,
    )
    if (reply.status === 200) state(world).exported = reply.body as Exported
  },
)

const exported = (world: World): Exported => {
  const found = state(world).exported
  if (!found) throw new Error("Nothing has been exported in this scenario")
  return found
}

Then("the exported file is:", async ({ world }, yaml: string) => {
  const file = exported(world)
  expect(parseYaml(file.yaml)).toEqual(parseYaml(fill(world, yaml)))
  // The YAML text and the parsed declaration beside it say the same thing.
  expect(file.declaration).toEqual(parseYaml(file.yaml))
})

Then("the exported file is the file that was applied", async ({ world }) => {
  expect(parseYaml(exported(world).yaml)).toEqual(parseYaml(theFile(world)))
})

Then(
  "the exported file declares the local-only service {string} of {string}",
  async ({ world }, service: string, fleet: string) => {
    const text = plain(world, exported(world).yaml)
    const declaration = parseYaml(text) as {
      projects: Record<string, { fleets: Record<string, { services: Record<string, unknown> }> }>
    }
    const found = Object.values(declaration.projects)
      .flatMap((project) => Object.entries(project.fleets))
      .find(([slug]) => slug === fleet)?.[1].services[service]
    expect(found, text).toMatchObject({ local: true })
  },
)

Then(
  /^the export says the organization is (configured by hand|managed by the file \w+ applied)$/,
  async ({ world }, outcome: string) => {
    const { managed } = exported(world)
    const person = /^managed by the file (\w+) applied$/.exec(outcome)?.[1]
    if (!person) expect(managed).toBeNull()
    else expect(managed?.appliedBy).toBe(world.email(person))
  },
)

When(step(`${ACTOR} applies the exported file`), async ({ world }, words: string) => {
  await sendFile(world, actor(world, words), exported(world).yaml)
})

When(
  step(`${ACTOR} saves the exported file as (?:her|his) mockingbird\\.yaml`),
  async ({ world }, words: string) => {
    actor(world, words)
    writeDeclaration(world, exported(world).yaml)
  },
)
