/** Tenancy and access: organization keys, project keys and personal tokens. */
import { expect } from "@playwright/test"
import { bodyOf, idOf, ownerOf, phrase, rememberKey, type Thing, who } from "../support/tenancy.js"
import type { World } from "../support/world.js"
import { Then, When } from "./common.steps.js"

type Key = {
  id: string
  name: string
  scope: string
  role: string | null
  orgId: string | null
  projectId: string | null
  prefix: string
  lastUsedAt: string | null
  expiresAt: string | null
  createdAt: string
  key?: string
}

/** The key the last call made, if it made one; remembered so it can act and be asserted on. */
function made(world: World, name: string) {
  if (world.last && world.last.status < 300)
    rememberKey(world, name, world.last.body as Record<string, unknown>)
}

const newKey = (world: World) => {
  expect(world.last?.status, world.last?.text).toBe(201)
  return world.last?.body as Key
}

const keysOf = async (world: World, org: string) => {
  const id = idOf(world, org)
  const owner = await ownerOf(world, id)
  return (await world.must<{ data: Key[] }>(owner, "GET", `/orgs/${id}/api-keys`)).data
}

// ---- making keys ---------------------------------------------------------------------------

When(
  phrase("{actor} makes an organization key {string} for {string}"),
  async ({ world }, actor: string, name: string, org: string) => {
    await world.api(who(actor), "POST", `/orgs/${idOf(world, org)}/api-keys`, { name })
    made(world, name)
  },
)

When(
  phrase("{actor} makes an organization key {string} for {string} with the {word} role"),
  async ({ world }, actor: string, name: string, org: string, role: string) => {
    await world.api(who(actor), "POST", `/orgs/${idOf(world, org)}/api-keys`, { name, role })
    made(world, name)
  },
)

When(
  phrase("{person} makes an organization key {string} for {string} that expires in {int} {days}"),
  async ({ world }, person: string, name: string, org: string, days: string) => {
    await world.api(person, "POST", `/orgs/${idOf(world, org)}/api-keys`, {
      name,
      expiresInDays: Number(days),
    })
    made(world, name)
  },
)

When(
  phrase("{person} makes a project key {string} for the project {string} in {string}"),
  async ({ world }, person: string, name: string, project: string, org: string) => {
    await world.api(person, "POST", `/orgs/${idOf(world, org)}/api-keys`, {
      name,
      projectId: idOf(world, project),
    })
    made(world, name)
  },
)

When(
  phrase(
    "{person} makes a project key {string} for the project {string} in {string} with the {word} role",
  ),
  async ({ world }, person: string, name: string, project: string, org: string, role: string) => {
    await world.api(person, "POST", `/orgs/${idOf(world, org)}/api-keys`, {
      name,
      role,
      projectId: idOf(world, project),
    })
    made(world, name)
  },
)

const BAD_KEYS: Record<string, unknown> = {
  "no name": {},
  "a blank name": { name: "" },
  "an expiry of 0 days": { name: "ci", expiresInDays: 0 },
  "an expiry of 367 days": { name: "ci", expiresInDays: 367 },
  "a role that is not known": { name: "ci", role: "superuser" },
}

When(
  phrase(
    "{person} tries to make an organization key for {string} with {options}",
    Object.keys(BAD_KEYS),
  ),
  async ({ world }, person: string, org: string, problem: string) => {
    await world.api(person, "POST", `/orgs/${idOf(world, org)}/api-keys`, BAD_KEYS[problem])
  },
)

const KINDS: Record<string, { scope: string; prefix: string }> = {
  "organization key": { scope: "org", prefix: "mbf_o_" },
  "project key": { scope: "project", prefix: "mbf_p_" },
  "personal token": { scope: "user", prefix: "mbf_u_" },
}

Then(
  phrase("the new key is {a} {options} with the {role} role", ["organization key", "project key"]),
  async ({ world }, kind: string, role: string) => {
    const key = newKey(world)
    expect(key.scope).toBe(KINDS[kind]?.scope)
    expect(key.role).toBe(role)
    expect(key.key?.startsWith(KINDS[kind]?.prefix ?? "?"), key.prefix).toBe(true)
    expect(key.projectId === null).toBe(kind === "organization key")
  },
)

Then("the new key is a personal token", async ({ world }) => {
  const key = newKey(world)
  expect(key).toMatchObject({ scope: "user", role: null, orgId: null, projectId: null })
  expect(key.key?.startsWith("mbf_u_")).toBe(true)
})

Then("the new key's secret is revealed", async ({ world }) => {
  const key = newKey(world)
  expect(key.key).toMatch(/^mbf_[uop]_[a-z0-9]{20}_[A-Za-z0-9_-]{43}$/)
  // The prefix is enough to recognise the key by, and far too little to use it.
  expect(key.key?.startsWith(key.prefix)).toBe(true)
  expect(key.prefix.length).toBeLessThan(20)
})

Then(
  phrase("the new key expires {int} days after it was made"),
  async ({ world }, days: string) => {
    const key = newKey(world)
    expect(Date.parse(key.expiresAt ?? "") - Date.parse(key.createdAt)).toBe(
      Number(days) * 86_400_000,
    )
  },
)

Then("the new key never expires", async ({ world }) => {
  expect(newKey(world).expiresAt).toBeNull()
})

// ---- listing and revoking ------------------------------------------------------------------

When(
  phrase("{person} lists the API keys of {string}"),
  async ({ world }, person: string, org: string) => {
    await world.api(person, "GET", `/orgs/${idOf(world, org)}/api-keys`)
  },
)

Then(
  phrase("the {kind} {string} is listed by its prefix, without its secret"),
  async ({ world }, name: string) => {
    const known = world.thing<Key>(name)
    const listed = bodyOf<{ data: Key[] }>(world).data.find((key) => key.id === known.id)
    expect(listed).toMatchObject({ name, prefix: known.prefix })
    expect(listed?.key).toBeUndefined()
    expect(world.last?.text).not.toContain(known.key)
  },
)

Then(
  phrase("the key {string} is listed in {string} as {options}", ["never used", "used"]),
  async ({ world }, name: string, org: string, state: string) => {
    const listed = (await keysOf(world, org)).find((key) => key.id === idOf(world, name))
    if (state === "never used") expect(listed?.lastUsedAt).toBeNull()
    else expect(Date.parse(listed?.lastUsedAt ?? "")).toBeGreaterThan(0)
  },
)

Then(phrase("{string} has no API keys"), async ({ world }, org: string) => {
  expect(await keysOf(world, org)).toEqual([])
})

When(
  phrase("{person} revokes the key {string} in {string}"),
  async ({ world }, person: string, name: string, org: string) => {
    await world.api(person, "DELETE", `/orgs/${idOf(world, org)}/api-keys/${idOf(world, name)}`)
  },
)

// ---- what a key can reach ------------------------------------------------------------------

const PATHS = { organization: "orgs", project: "projects", fleet: "fleets" } as const

When(
  phrase("{actor} asks for the {resource} {string}"),
  async ({ world }, actor: string, kind: keyof typeof PATHS, name: string) => {
    await world.api(who(actor), "GET", `/${PATHS[kind]}/${idOf(world, name)}`)
  },
)

When(
  phrase("{actor} lists the projects of {string}"),
  async ({ world }, actor: string, org: string) => {
    await world.api(who(actor), "GET", `/orgs/${idOf(world, org)}/projects`)
  },
)

Then(phrase("the projects listed are {string}"), async ({ world }, list: string) => {
  expect(world.last?.status, world.last?.text).toBe(200)
  expect(
    bodyOf<{ data: Thing[] }>(world)
      .data.map((project) => project.name)
      .sort(),
  ).toEqual(
    list
      .split(",")
      .map((name) => name.trim())
      .filter(Boolean)
      .sort(),
  )
})

// ---- personal tokens -----------------------------------------------------------------------

When(
  phrase("{actor} makes a personal token {string}"),
  async ({ world }, actor: string, name: string) => {
    await world.api(who(actor), "POST", "/tokens", { name })
    made(world, name)
  },
)

When(
  phrase("{person} tries to make a personal token without a name"),
  async ({ world }, person: string) => {
    await world.api(person, "POST", "/tokens", {})
  },
)

When(phrase("{person} lists their personal tokens"), async ({ world }, person: string) => {
  await world.api(person, "GET", "/tokens")
})

Then(phrase("the personal tokens listed are {string}"), async ({ world }, list: string) => {
  expect(world.last?.status, world.last?.text).toBe(200)
  expect(
    bodyOf<{ data: Key[] }>(world)
      .data.map((token) => token.name)
      .sort(),
  ).toEqual(
    list
      .split(",")
      .map((name) => name.trim())
      .filter(Boolean)
      .sort(),
  )
})

When(
  phrase("{person} revokes the personal token {string}"),
  async ({ world }, person: string, name: string) => {
    await world.api(person, "DELETE", `/tokens/${idOf(world, name)}`)
  },
)
