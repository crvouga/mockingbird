/** Tenancy and access: projects, fleets as resources, and the emulators a fleet is configured with. */
import { expect } from "@playwright/test"
import type { DataTable } from "playwright-bdd"
import { bodyOf, idOf, ownerOf, phrase, type Thing, uniqueSlug } from "../support/tenancy.js"
import type { World } from "../support/world.js"
import { Then, When } from "./common.steps.js"

type Emulator = {
  target: string
  durability: string
  seed?: string
  settings?: Record<string, unknown>
  flushIntervalMs?: number
  webhookOrigins?: string[]
  url: string
}
type Fleet = Thing & {
  orgId: string
  projectId: string
  access: string
  url: string
  emulators: Record<string, Emulator>
}

const remember = (world: World, name: string) => {
  if (world.last && world.last.status < 300)
    world.things.set(name, world.last.body as Record<string, unknown>)
}

const listed = (list: string) =>
  list
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean)
    .sort()

/** A resource as it is now, read by an owner of its organization. */
async function current<T extends Thing>(world: World, path: string, name: string): Promise<T> {
  const known = world.thing<Thing & { orgId?: string }>(name)
  const owner = await ownerOf(world, known.orgId ?? known.id)
  return world.must<T>(owner, "GET", `/${path}/${known.id}`)
}
const fleetNow = (world: World, name: string) => current<Fleet>(world, "fleets", name)

/** A table cell as a value: JSON when it parses (`true`, `100`, `"yes"`), text otherwise. */
const cell = (text: string): unknown => {
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}
const fields = (table: DataTable): Record<string, unknown> =>
  Object.fromEntries(table.raw().map(([key, value]) => [key, cell(value ?? "")]))

// ---- projects ------------------------------------------------------------------------------

When(
  phrase("{person} creates a project named {string} in {string}"),
  async ({ world }, person: string, name: string, org: string) => {
    await world.api(person, "POST", `/orgs/${idOf(world, org)}/projects`, { name })
    remember(world, name)
  },
)

When(
  phrase("{person} creates a project named {string} in {string} with the slug {string}"),
  async ({ world }, person: string, name: string, org: string, slug: string) => {
    await world.api(person, "POST", `/orgs/${idOf(world, org)}/projects`, { name, slug })
    remember(world, name)
  },
)

Then(
  phrase("the project {string} belongs to {string}"),
  async ({ world }, name: string, org: string) => {
    expect((await current<Thing>(world, "projects", name)).orgId).toBe(idOf(world, org))
  },
)

Then(
  phrase("the projects of {string} are {string}"),
  async ({ world }, org: string, list: string) => {
    const id = idOf(world, org)
    const { data } = await world.must<{ data: Thing[] }>(
      await ownerOf(world, id),
      "GET",
      `/orgs/${id}/projects`,
    )
    expect(data.map((project) => project.name).sort()).toEqual(listed(list))
  },
)

Then(
  phrase("the {resource} {string} has a slug starting with {string}"),
  async ({ world }, _kind: string, name: string, prefix: string) => {
    const { slug } = world.thing<Thing>(name)
    expect(slug.startsWith(prefix), slug).toBe(true)
    expect(slug.slice(prefix.length)).toMatch(/^[a-z0-9]{6}$/)
  },
)

Then(
  phrase("the project {string} has the slug {string}"),
  async ({ world }, name: string, slug: string) => {
    expect((await current<Thing>(world, "projects", name)).slug).toBe(slug)
  },
)

When(
  phrase("{person} renames the project {string} to {string}"),
  async ({ world }, person: string, name: string, next: string) => {
    await world.api(person, "PATCH", `/projects/${idOf(world, name)}`, { name: next })
  },
)

When(
  phrase("{person} deletes the project {string}"),
  async ({ world }, person: string, name: string) => {
    await world.api(person, "DELETE", `/projects/${idOf(world, name)}`)
  },
)

// ---- fleets --------------------------------------------------------------------------------

const createFleet = async (world: World, person: string, project: string, body: Thing | object) => {
  await world.api(person, "POST", `/projects/${idOf(world, project)}/fleets`, body)
  if ("name" in body && typeof body.name === "string") remember(world, body.name)
}

When(
  phrase("{person} creates a fleet named {string} in {string}"),
  async ({ world }, person: string, name: string, project: string) => {
    await createFleet(world, person, project, { name })
  },
)

When(
  phrase("{person} creates a fleet named {string} in {string} with the slug {string}"),
  async ({ world }, person: string, name: string, project: string, slug: string) => {
    await createFleet(world, person, project, { name, slug: uniqueSlug(world, slug) })
  },
)

When(
  phrase("{person} creates a fleet named {string} in {string} that needs an API key"),
  async ({ world }, person: string, name: string, project: string) => {
    await createFleet(world, person, project, { name, access: "key" })
  },
)

When(
  phrase("{person} creates a fleet named {string} in {string} with the emulators:"),
  async ({ world }, person: string, name: string, project: string, table: DataTable) => {
    const emulators = Object.fromEntries(
      table
        .hashes()
        .map((row) => [
          row.name,
          { target: row.emulates, ...(row.durability ? { durability: row.durability } : {}) },
        ]),
    )
    await createFleet(world, person, project, { name, emulators })
  },
)

const BAD_FLEETS: Record<string, unknown> = {
  "no name": {},
  "a blank name": { name: "" },
  "a name of 81 characters": { name: "x".repeat(81) },
  "a malformed slug": { name: "Staging", slug: "Not A Slug" },
  "an unknown access setting": { name: "Staging", access: "secret" },
  "an unrecognised field": { name: "Staging", colour: "blue" },
  "an emulator without a target": {
    name: "Staging",
    emulators: { mail: { durability: "strict" } },
  },
  "several problems at once": { slug: "Not A Slug", access: "secret", colour: "blue" },
}

When(
  phrase("{person} tries to create a fleet in {string} with {options}", Object.keys(BAD_FLEETS)),
  async ({ world }, person: string, project: string, problem: string) => {
    await world.api(person, "POST", `/projects/${idOf(world, project)}/fleets`, BAD_FLEETS[problem])
  },
)

const problems = (world: World) =>
  bodyOf<{ error?: { details?: string[] } }>(world).error?.details ?? []

Then(phrase("the problems listed include {string}"), async ({ world }, detail: string) => {
  expect(
    problems(world).some((problem) => problem.includes(detail)),
    world.last?.text,
  ).toBe(true)
})

Then(phrase("{int} problems are listed"), async ({ world }, count: string) => {
  expect(problems(world), world.last?.text).toHaveLength(Number(count))
})

const fleetsOf = async (world: World, project: string) => {
  const known = world.thing<Thing & { orgId: string }>(project)
  const owner = await ownerOf(world, known.orgId)
  return (await world.must<{ data: Fleet[] }>(owner, "GET", `/projects/${known.id}/fleets`)).data
}

Then(phrase("the project {string} has no fleets"), async ({ world }, project: string) => {
  expect(await fleetsOf(world, project)).toEqual([])
})

Then(
  phrase("the fleets of the project {string} are {string}"),
  async ({ world }, project: string, list: string) => {
    expect((await fleetsOf(world, project)).map((fleet) => fleet.name).sort()).toEqual(listed(list))
  },
)

Then(
  phrase("the fleet {string} belongs to the project {string}"),
  async ({ world }, name: string, project: string) => {
    const fleet = await fleetNow(world, name)
    expect(fleet.projectId).toBe(idOf(world, project))
    expect(fleet.orgId).toBe(world.thing<{ orgId: string }>(project).orgId)
  },
)

Then(phrase("the fleet {string} is addressed by its slug"), async ({ world }, name: string) => {
  const fleet = await fleetNow(world, name)
  expect(fleet.url).toBe(`${world.url}/f/${fleet.slug}`)
})

Then(
  phrase("the fleet {string} is addressed as {string}"),
  async ({ world }, name: string, path: string) => {
    const slug = uniqueSlug(world, path.replace(/^\/f\//, ""))
    const fleet = await fleetNow(world, name)
    expect(fleet.slug).toBe(slug)
    expect(fleet.url).toBe(`${world.url}/f/${slug}`)
  },
)

Then(
  phrase("the fleet {string} is now called {string}"),
  async ({ world }, name: string, expected: string) => {
    expect((await fleetNow(world, name)).name).toBe(expected)
  },
)

Then(phrase("the fleet {string} has no emulators"), async ({ world }, name: string) => {
  expect((await fleetNow(world, name)).emulators).toEqual({})
})

Then(
  phrase("the fleet {string} has {int} emulators"),
  async ({ world }, name: string, count: string) => {
    expect(Object.keys((await fleetNow(world, name)).emulators)).toHaveLength(Number(count))
  },
)

Then(
  phrase("the fleet {string} has the emulators:"),
  async ({ world }, name: string, table: DataTable) => {
    const { emulators } = await fleetNow(world, name)
    expect(
      Object.entries(emulators)
        .map(([key, spec]) => ({ name: key, emulates: spec.target, durability: spec.durability }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    ).toEqual(table.hashes().sort((a, b) => (a.name ?? "").localeCompare(b.name ?? "")))
  },
)

Then(
  phrase("each emulator of the fleet {string} is addressed beneath the fleet, by its name"),
  async ({ world }, name: string) => {
    const fleet = await fleetNow(world, name)
    expect(Object.keys(fleet.emulators).length).toBeGreaterThan(0)
    for (const [key, spec] of Object.entries(fleet.emulators))
      expect(spec.url).toBe(`${fleet.url}/${key}`)
  },
)

const ACCESS = {
  "open to anyone who knows its address": "open",
  "closed to callers without an API key": "key",
} as const

Then(
  phrase("the fleet {string} is {options}", Object.keys(ACCESS)),
  async ({ world }, name: string, access: keyof typeof ACCESS) => {
    expect((await fleetNow(world, name)).access).toBe(ACCESS[access])
  },
)

const patchFleet = (world: World, person: string, name: string, body: unknown) =>
  world.api(person, "PATCH", `/fleets/${idOf(world, name)}`, body)

When(
  phrase("{person} renames the fleet {string} to {string}"),
  async ({ world }, person: string, name: string, next: string) => {
    await patchFleet(world, person, name, { name: next })
  },
)

When(
  phrase("{person} tries to move the fleet {string} to the slug {string}"),
  async ({ world }, person: string, name: string, slug: string) => {
    await patchFleet(world, person, name, { slug: uniqueSlug(world, slug) })
  },
)

When(
  phrase("{person} restricts the fleet {string} to callers with an API key"),
  async ({ world }, person: string, name: string) => {
    await patchFleet(world, person, name, { access: "key" })
  },
)

When(
  phrase("{person} opens the fleet {string} to anyone who knows its address"),
  async ({ world }, person: string, name: string) => {
    await patchFleet(world, person, name, { access: "open" })
  },
)

When(
  phrase("{person} sets the access of the fleet {string} to {string}"),
  async ({ world }, person: string, name: string, access: string) => {
    await patchFleet(world, person, name, { access })
  },
)

When(
  phrase("{person} deletes the fleet called {string}"),
  async ({ world }, person: string, name: string) => {
    await world.api(person, "DELETE", `/fleets/${idOf(world, name)}`)
  },
)

// ---- emulators -----------------------------------------------------------------------------

const emulatorPath = (world: World, fleet: string, name: string) =>
  `/fleets/${idOf(world, fleet)}/emulators/${name}`

When(
  phrase("{person} adds a {string} emulator named {string} to the fleet {string}"),
  async ({ world }, person: string, target: string, name: string, fleet: string) => {
    await world.api(person, "PUT", emulatorPath(world, fleet, name), { target })
  },
)

When(
  phrase("{person} adds a {string} emulator named {string} to the fleet {string} with:"),
  async (
    { world },
    person: string,
    target: string,
    name: string,
    fleet: string,
    table: DataTable,
  ) => {
    await world.api(person, "PUT", emulatorPath(world, fleet, name), { target, ...fields(table) })
  },
)

When(
  phrase(
    "{person} adds a {string} emulator named {string} to the fleet {string} with the settings:",
  ),
  async (
    { world },
    person: string,
    target: string,
    name: string,
    fleet: string,
    table: DataTable,
  ) => {
    await world.api(person, "PUT", emulatorPath(world, fleet, name), {
      target,
      settings: fields(table),
    })
  },
)

When(
  phrase("{person} changes the emulator {string} of the fleet {string} with:"),
  async ({ world }, person: string, name: string, fleet: string, table: DataTable) => {
    await world.api(person, "PATCH", emulatorPath(world, fleet, name), fields(table))
  },
)

When(
  phrase("{person} removes the emulator {string} from the fleet {string}"),
  async ({ world }, person: string, name: string, fleet: string) => {
    await world.api(person, "DELETE", emulatorPath(world, fleet, name))
  },
)

const emulatorNow = async (world: World, fleet: string, name: string) => {
  const found = (await fleetNow(world, fleet)).emulators[name]
  if (!found) throw new Error(`The fleet "${fleet}" has no emulator "${name}"`)
  return found
}

Then(
  phrase("the emulator {string} of the fleet {string} is configured with:"),
  async ({ world }, name: string, fleet: string, table: DataTable) => {
    const emulator = (await emulatorNow(world, fleet, name)) as unknown as Record<string, unknown>
    for (const [key, value] of table.raw())
      expect(emulator[key ?? ""], key).toEqual(value ? cell(value) : undefined)
  },
)

Then(
  phrase("the emulator {string} of the fleet {string} has the settings:"),
  async ({ world }, name: string, fleet: string, table: DataTable) => {
    expect((await emulatorNow(world, fleet, name)).settings).toEqual(fields(table))
  },
)

Then(
  phrase("the emulator {string} of the fleet {string} has no settings"),
  async ({ world }, name: string, fleet: string) => {
    expect((await emulatorNow(world, fleet, name)).settings).toBeUndefined()
  },
)

When(
  phrase("{person} lets the emulator {string} of the fleet {string} deliver webhooks to {string}"),
  async ({ world }, person: string, name: string, fleet: string, origin: string) => {
    await world.api(person, "PUT", emulatorPath(world, fleet, name), {
      target: "resend",
      webhookOrigins: [origin],
    })
  },
)

When(
  phrase("{person} stops the emulator {string} of the fleet {string} delivering webhooks"),
  async ({ world }, person: string, name: string, fleet: string) => {
    await world.api(person, "PATCH", emulatorPath(world, fleet, name), { webhookOrigins: [] })
  },
)

Then(
  phrase("the emulator {string} of the fleet {string} may deliver webhooks to {string}"),
  async ({ world }, name: string, fleet: string, origin: string) => {
    expect((await emulatorNow(world, fleet, name)).webhookOrigins).toEqual([origin])
  },
)

Then(
  phrase("the emulator {string} of the fleet {string} may deliver webhooks to no origins"),
  async ({ world }, name: string, fleet: string) => {
    expect((await emulatorNow(world, fleet, name)).webhookOrigins).toBeUndefined()
  },
)

// ---- simultaneous edits --------------------------------------------------------------------

const allSucceeded = (replies: { status: number; text: string }[]) => {
  for (const reply of replies) expect(reply.status, reply.text).toBe(200)
}

When(
  phrase(
    "{person} adds a {string} emulator named {string} while {person} adds a {string} emulator named {string} to the fleet {string}",
  ),
  async (
    { world },
    one: string,
    oneTarget: string,
    oneName: string,
    other: string,
    otherTarget: string,
    otherName: string,
    fleet: string,
  ) => {
    await Promise.all([world.person(one), world.person(other)])
    allSucceeded(
      await Promise.all([
        world.api(one, "PUT", emulatorPath(world, fleet, oneName), { target: oneTarget }),
        world.api(other, "PUT", emulatorPath(world, fleet, otherName), { target: otherTarget }),
      ]),
    )
  },
)

When(
  phrase(
    "{person} makes the emulators {string} and {string} of the fleet {string} strict at the same moment",
  ),
  async ({ world }, person: string, one: string, other: string, fleet: string) => {
    allSucceeded(
      await Promise.all(
        [one, other].map((name) =>
          world.api(person, "PATCH", emulatorPath(world, fleet, name), { durability: "strict" }),
        ),
      ),
    )
  },
)

When(
  phrase("{person} adds {int} {string} emulators to the fleet {string} at the same moment"),
  async ({ world }, person: string, count: string, target: string, fleet: string) => {
    await world.person(person)
    allSucceeded(
      await Promise.all(
        Array.from({ length: Number(count) }, (_, index) =>
          world.api(person, "PUT", emulatorPath(world, fleet, `burst-${index + 1}`), { target }),
        ),
      ),
    )
  },
)
