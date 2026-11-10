/** Tenancy and access: organizations, their members and invites. */
import { expect } from "@playwright/test"
import type { DataTable } from "playwright-bdd"
import {
  bodyOf,
  expire,
  idOf,
  membersOf,
  ownerOf,
  phrase,
  type Role,
  roleIn,
  send,
  storedState,
  type Thing,
  uniqueSlug,
  userId,
  who,
} from "../support/tenancy.js"
import type { World } from "../support/world.js"
import { Given, Then, When } from "./common.steps.js"

/** Remember what was just created under the name the feature uses, when it was created. */
function remember(world: World, name: string) {
  if (world.last && world.last.status < 300)
    world.things.set(name, world.last.body as Record<string, unknown>)
}

// ---- organizations -------------------------------------------------------------------------

When(
  phrase("{actor} creates an organization named {string}"),
  async ({ world }, actor: string, name: string) => {
    await world.api(who(actor), "POST", "/orgs", { name })
    remember(world, name)
  },
)

When(
  phrase("{person} creates an organization named {string} with the slug {string}"),
  async ({ world }, person: string, name: string, slug: string) => {
    await world.api(person, "POST", "/orgs", { name, slug: uniqueSlug(world, slug) })
    remember(world, name)
  },
)

Given(
  phrase("{person} owns an organization {string} with the slug {string}"),
  async ({ world }, person: string, name: string, slug: string) => {
    world.things.set(
      name,
      await world.must(person, "POST", "/orgs", { name, slug: uniqueSlug(world, slug) }),
    )
  },
)

When(
  phrase("{person} tries to create an organization with the malformed slug {string}"),
  async ({ world }, person: string, slug: string) => {
    await world.api(person, "POST", "/orgs", { name: "Acme", slug })
  },
)

const BAD_ORGANIZATIONS: Record<string, unknown> = {
  "no name": {},
  "a blank name": { name: "" },
  "a name of 81 characters": { name: "x".repeat(81) },
  "an unrecognised field": { name: "Acme", plan: "enterprise" },
}

When(
  phrase("{person} tries to create an organization with {options}", Object.keys(BAD_ORGANIZATIONS)),
  async ({ world }, person: string, problem: string) => {
    await world.api(person, "POST", "/orgs", BAD_ORGANIZATIONS[problem])
  },
)

Then(
  phrase("the organization {string} has the slug {string}"),
  async ({ world }, name: string, slug: string) => {
    expect(world.thing<Thing>(name).slug).toBe(uniqueSlug(world, slug))
  },
)

When(phrase("{actor} lists the organizations they belong to"), async ({ world }, actor: string) => {
  await world.api(who(actor), "GET", "/orgs")
})

const names = (list: string) =>
  list
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean)
    .sort()

Then(phrase("the organizations listed are {string}"), async ({ world }, list: string) => {
  expect(world.last?.status, world.last?.text).toBe(200)
  const listed = bodyOf<{ data: Thing[] }>(world).data
  expect(listed.map((org) => org.name).sort()).toEqual(names(list))
  // Never anything but organizations this scenario made.
  for (const org of listed) expect(idOf(world, org.name)).toBe(org.id)
})

Then(
  phrase("{person} belongs to {int} organization"),
  async ({ world }, person: string, count: string) => {
    const { data } = await world.must<{ data: unknown[] }>(person, "GET", "/orgs")
    expect(data).toHaveLength(Number(count))
  },
)

When(
  phrase("{person} renames the organization {string} to {string}"),
  async ({ world }, person: string, name: string, next: string) => {
    await world.api(person, "PATCH", `/orgs/${idOf(world, name)}`, { name: next })
  },
)

Then(
  phrase("the organization {string} is now called {string}"),
  async ({ world }, name: string, expected: string) => {
    const org = idOf(world, name)
    const found = await world.must<Thing>(await ownerOf(world, org), "GET", `/orgs/${org}`)
    expect(found.name).toBe(expected)
  },
)

Then(
  phrase("the organization {string} still has its original slug"),
  async ({ world }, name: string) => {
    const before = world.thing<Thing>(name)
    const found = await world.must<Thing>(
      await ownerOf(world, before.id),
      "GET",
      `/orgs/${before.id}`,
    )
    expect(found.slug).toBe(before.slug)
  },
)

When(
  phrase("{person} deletes the organization {string}"),
  async ({ world }, person: string, name: string) => {
    await world.api(person, "DELETE", `/orgs/${idOf(world, name)}`)
  },
)

const PATHS = { organization: "orgs", project: "projects", fleet: "fleets" } as const

Then(
  phrase("the {resource} {string} no longer exists for {person}"),
  async ({ world }, kind: keyof typeof PATHS, name: string, person: string) => {
    const reply = await world.api(person, "GET", `/${PATHS[kind]}/${idOf(world, name)}`)
    expect(reply.status, reply.text).toBe(404)
  },
)

Then(
  phrase("the {resource} {string} still exists for {person}"),
  async ({ world }, kind: keyof typeof PATHS, name: string, person: string) => {
    const reply = await world.api(person, "GET", `/${PATHS[kind]}/${idOf(world, name)}`)
    expect(reply.status, reply.text).toBe(200)
  },
)

Then(
  phrase("nothing is served at the address of the fleet {string}"),
  async ({ world }, name: string) => {
    const reply = await send(world, "GET", `/f/${world.thing<Thing>(name).slug}`)
    expect(reply.status, reply.text).toBe(404)
  },
)

Given(
  phrase("the {string} emulator of the fleet {string} has stored state"),
  async ({ world }, emulator: string, name: string) => {
    const fleet = world.thing<Thing>(name)
    // The emulator is `strict`, so the reply is only sent once its state is in the bucket.
    const reply = await world.emulator(fleet.slug, emulator, "POST", "/emails", {
      headers: { authorization: "Bearer re_vendor_key" },
      body: { from: "a@example.test", to: "b@example.test", subject: "hi", html: "<p>hi</p>" },
    })
    expect(reply.status, reply.text).toBe(200)
    expect(await storedState(world, fleet.id)).not.toEqual([])
  },
)

Then(
  phrase("no emulator state remains stored for the fleet {string}"),
  async ({ world }, name: string) => {
    expect(await storedState(world, idOf(world, name))).toEqual([])
  },
)

// ---- members -------------------------------------------------------------------------------

Then(phrase("the members of {string} are:"), async ({ world }, org: string, table: DataTable) => {
  const members = await membersOf(world, idOf(world, org))
  const row = (member: { email: string | null; role: string }) => `${member.email} ${member.role}`
  expect(members.map(row).sort()).toEqual(
    table
      .hashes()
      .map((expected) =>
        row({ email: world.email(expected.person ?? ""), role: expected.role ?? "" }),
      )
      .sort(),
  )
})

Then(phrase("{string} has {int} {members}"), async ({ world }, org: string, count: string) => {
  expect(await membersOf(world, idOf(world, org))).toHaveLength(Number(count))
})

Then(
  phrase("{person} is {still}{a} {role} of {string}"),
  async ({ world }, person: string, role: Role, org: string) => {
    expect(await roleIn(world, person, idOf(world, org))).toBe(role)
  },
)

Then(phrase("{person} cannot see {string}"), async ({ world }, person: string, org: string) => {
  const reply = await world.api(person, "GET", `/orgs/${idOf(world, org)}`)
  expect(reply.status, reply.text).toBe(404)
  const { data } = await world.must<{ data: Thing[] }>(person, "GET", "/orgs")
  expect(data.map((entry) => entry.id)).not.toContain(idOf(world, org))
})

When(
  phrase("{person} changes {person}'s role in {string} to {word}"),
  async ({ world }, person: string, target: string, org: string, role: string) => {
    const id = await userId(world, target)
    await world.api(person, "PATCH", `/orgs/${idOf(world, org)}/members/${id}`, { role })
  },
)

When(phrase("{person} leaves {string}"), async ({ world }, person: string, org: string) => {
  const id = await userId(world, person)
  await world.api(person, "DELETE", `/orgs/${idOf(world, org)}/members/${id}`)
})

When(
  phrase("{person} removes {person} from {string}"),
  async ({ world }, person: string, target: string, org: string) => {
    const id = await userId(world, target)
    await world.api(person, "DELETE", `/orgs/${idOf(world, org)}/members/${id}`)
  },
)

// ---- invites -------------------------------------------------------------------------------

type Invite = { id: string; email: string; role: string; token?: string; acceptUrl?: string } & {
  expiresAt: string
  createdAt: string
}

const inviteName = (person: string) => `the invite for ${person}`

async function invite(world: World, actor: string, person: string, org: string, role?: string) {
  await world.api(who(actor), "POST", `/orgs/${idOf(world, org)}/invites`, {
    email: world.email(person),
    ...(role ? { role } : {}),
  })
  remember(world, inviteName(person))
}

When(
  phrase("{actor} invites {person} to {string} as {a} {word}"),
  async ({ world }, actor: string, person: string, org: string, role: string) => {
    await invite(world, actor, person, org, role)
  },
)

When(
  phrase("{person} invites {person} to {string} without naming a role"),
  async ({ world }, actor: string, person: string, org: string) => {
    await invite(world, actor, person, org)
  },
)

When(
  phrase("{person} invites the address {string} to {string}"),
  async ({ world }, person: string, email: string, org: string) => {
    await world.api(person, "POST", `/orgs/${idOf(world, org)}/invites`, { email })
  },
)

Given(
  phrase("{person} has invited {person} to {string} as {a} {role}"),
  async ({ world }, actor: string, person: string, org: string, role: Role) => {
    await invite(world, actor, person, org, role)
    expect(world.last?.status, world.last?.text).toBe(201)
  },
)

const pendingInvites = async (world: World, org: string) => {
  const id = idOf(world, org)
  const owner = await ownerOf(world, id)
  return (await world.must<{ data: Invite[] }>(owner, "GET", `/orgs/${id}/invites`)).data
}

Then(
  phrase("the invite for {person} is a link to the dashboard"),
  async ({ world }, person: string) => {
    const made = world.thing<Invite>(inviteName(person))
    expect(made.token).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(made.acceptUrl).toBe(`${world.url}/invite/${made.token}`)
  },
)

Then(
  phrase("the pending invites of {string} are:"),
  async ({ world }, org: string, table: DataTable) => {
    const row = (entry: { email: string; role: string }) => `${entry.email} ${entry.role}`
    expect((await pendingInvites(world, org)).map(row).sort()).toEqual(
      table
        .hashes()
        .map((expected) =>
          row({ email: world.email(expected.person ?? ""), role: expected.role ?? "" }),
        )
        .sort(),
    )
  },
)

Then(phrase("{string} has no pending invites"), async ({ world }, org: string) => {
  expect(await pendingInvites(world, org)).toEqual([])
})

Then(
  phrase("the invite for {person} is still pending in {string}"),
  async ({ world }, person: string, org: string) => {
    const pending = await pendingInvites(world, org)
    expect(pending.map((entry) => entry.id)).toContain(idOf(world, inviteName(person)))
  },
)

Then(
  phrase("the pending invites of {string} do not reveal the link for {person}"),
  async ({ world }, org: string, person: string) => {
    const made = world.thing<Invite>(inviteName(person))
    const pending = await pendingInvites(world, org)
    expect(pending.map((entry) => entry.id)).toEqual([made.id])
    expect(pending[0]?.token).toBeUndefined()
    expect(pending[0]?.acceptUrl).toBeUndefined()
    expect(JSON.stringify(pending)).not.toContain(made.token)
  },
)

Then(
  phrase("the invite for {person} expires {int} days after it was made"),
  async ({ world }, person: string, days: string) => {
    const made = world.thing<Invite>(inviteName(person))
    expect(Date.parse(made.expiresAt) - Date.parse(made.createdAt)).toBe(Number(days) * 86_400_000)
  },
)

const accept = (world: World, actor: string, token: string) =>
  world.api(who(actor), "POST", "/invites/accept", { token })

When(phrase("{person} accepts their invite"), async ({ world }, person: string) => {
  await accept(world, person, world.thing<Invite>(inviteName(person)).token ?? "")
})

When(
  phrase("{actor} accepts the invite meant for {person}"),
  async ({ world }, actor: string, person: string) => {
    await accept(world, actor, world.thing<Invite>(inviteName(person)).token ?? "")
  },
)

When(
  phrase("{person} accepts an invite link that was never issued"),
  async ({ world }, person: string) => {
    await accept(world, person, "A".repeat(43))
  },
)

When(
  phrase("{person} and {person} accept the invite meant for {person} at the same moment"),
  async ({ world }, one: string, other: string, person: string) => {
    const token = world.thing<Invite>(inviteName(person)).token ?? ""
    // Sign both in first, so the two acceptances really are sent together.
    await Promise.all([world.person(one), world.person(other)])
    const replies = await Promise.all([accept(world, one, token), accept(world, other, token)])
    expect(replies.map((reply) => reply.status).sort()).toEqual([200, 404])
  },
)

Then(
  phrase("exactly one of {person} and {person} has joined {string}"),
  async ({ world }, one: string, other: string, org: string) => {
    const id = idOf(world, org)
    const roles = [await roleIn(world, one, id), await roleIn(world, other, id)]
    expect(roles.filter(Boolean)).toHaveLength(1)
  },
)

When(
  phrase("{person} revokes the invite for {person} in {string}"),
  async ({ world }, person: string, invited: string, org: string) => {
    const id = idOf(world, inviteName(invited))
    await world.api(person, "DELETE", `/orgs/${idOf(world, org)}/invites/${id}`)
  },
)

Given(
  phrase("the invite for {person} has passed its expiry"),
  async ({ world }, person: string) => {
    expire(world, "invites", "id", idOf(world, inviteName(person)))
  },
)
