/**
 * Tenancy and access: the people, roles and credentials every other tenancy step builds on, and
 * the "who may do what" matrix. Organizations, keys, resources, the audit log and the API
 * contract have their own `tenancy-*.steps.ts` files.
 */
import { expect } from "@playwright/test"
import { createBdd } from "playwright-bdd"
import { test } from "../support/fixtures.js"
import {
  createKey,
  expire,
  first,
  idOf,
  join,
  keyOf,
  membersOf,
  ownerOf,
  phrase,
  type Role,
  rememberKey,
  send,
  stopTenancyStack,
  type Thing,
  tenancyStack,
  userId,
  who,
} from "../support/tenancy.js"
import type { World } from "../support/world.js"
import { Given, Then, When } from "./common.steps.js"

const { Before, AfterWorker } = createBdd(test)

// Tenancy scenarios sign in many people from one address; see `tenancyStack`.
Before({ tags: "@tenancy" }, async ({ world }) => {
  world.stack = await tenancyStack()
})
AfterWorker(async () => {
  await stopTenancyStack()
})

// ---- people and what they have -------------------------------------------------------------

Given(
  phrase("{person} has joined {string} with the {role} role"),
  async ({ world }, person: string, org: string, role: Role) => {
    await join(world, person, org, role)
  },
)

Given(
  phrase("{person} has a fleet {string} in the project {string}"),
  async ({ world }, person: string, name: string, project: string) => {
    world.things.set(
      name,
      await world.must(person, "POST", `/projects/${idOf(world, project)}/fleets`, { name }),
    )
  },
)

Given(
  phrase(
    "{person} has a fleet {string} in the project {string} with a {string} emulator named {string}",
  ),
  async (
    { world },
    person: string,
    name: string,
    project: string,
    target: string,
    emulator: string,
  ) => {
    world.things.set(
      name,
      await world.must(person, "POST", `/projects/${idOf(world, project)}/fleets`, {
        name,
        emulators: { [emulator]: { target, durability: "strict" } },
      }),
    )
  },
)

Given(
  phrase("{person} has an organization key {string} for {string} with the {role} role"),
  async ({ world }, person: string, name: string, org: string, role: Role) => {
    await createKey(world, person, org, name, { role })
  },
)

Given(
  phrase("{person} has a project key {string} for the project {string} with the {role} role"),
  async ({ world }, person: string, name: string, project: string, role: Role) => {
    const org = [...world.things.entries()].find(
      ([, thing]) => thing.id === world.thing<{ orgId: string }>(project).orgId,
    )?.[0]
    if (!org) throw new Error(`The organization of "${project}" is not known to this scenario`)
    await createKey(world, person, org, name, { role, project })
  },
)

Given(
  phrase("{person} has a personal token {string}"),
  async ({ world }, person: string, name: string) => {
    rememberKey(world, name, await world.must(person, "POST", "/tokens", { name }))
  },
)

Given(
  phrase("{person} has a personal token {string} that expires in {int} {days}"),
  async ({ world }, person: string, name: string, days: string) => {
    rememberKey(
      world,
      name,
      await world.must(person, "POST", "/tokens", { name, expiresInDays: Number(days) }),
    )
  },
)

// ---- identity ------------------------------------------------------------------------------

const BAD_CREDENTIALS: Record<string, string> = {
  "a malformed key": "mbf_o_nope",
  "a well-formed key that was never issued": `mbf_o_${"a".repeat(20)}_${"A".repeat(43)}`,
  "a well-formed personal token that was never issued": `mbf_u_${"b".repeat(20)}_${"B".repeat(43)}`,
}

When(
  phrase("a caller presenting {options} asks who they are", Object.keys(BAD_CREDENTIALS)),
  async ({ world }, credential: string) => {
    await world.api({ kind: "key", key: BAD_CREDENTIALS[credential] ?? "" }, "GET", "/me")
  },
)

When(phrase("{actor} asks who they are"), async ({ world }, actor: string) => {
  await world.api(who(actor), "GET", "/me")
})

When(
  phrase("the key {string} is presented in the dedicated API-key header"),
  async ({ world }, name: string) => {
    const credential = keyOf(world, name)
    await send(world, "GET", "/api/v1/me", {
      headers: { "x-mockingbird-api-key": credential.kind === "key" ? credential.key : "" },
    })
  },
)

Then(phrase("they are recognised as the person {person}"), async ({ world }, person: string) => {
  expect(world.last?.status, world.last?.text).toBe(200)
  expect(world.last?.body).toMatchObject({ kind: "user", user: { email: world.email(person) } })
})

Then(
  phrase("they are recognised as an API key of {string} with the {role} role"),
  async ({ world }, org: string, role: Role) => {
    expect(world.last?.status, world.last?.text).toBe(200)
    const body = world.last?.body as { kind: string; user?: unknown; orgs: Thing[] }
    expect(body.kind).toBe("api_key")
    expect(body.user).toBeUndefined()
    expect(body.orgs.map((entry) => [entry.id, entry.role])).toEqual([[idOf(world, org), role]])
  },
)

Then(phrase("the {kind} {string} is no longer accepted"), async ({ world }, name: string) => {
  const reply = await world.api(name, "GET", "/me")
  expect(reply.status, reply.text).toBe(401)
  expect(world.errorCode).toBe("unauthorized")
})

Then(phrase("the {kind} {string} is still accepted"), async ({ world }, name: string) => {
  const reply = await world.api(name, "GET", "/me")
  expect(reply.status, reply.text).toBe(200)
})

When(phrase("the {kind} {string} has passed its expiry"), async ({ world }, name: string) => {
  expire(world, "api_keys", "id", idOf(world, name))
})

// ---- browser sessions ----------------------------------------------------------------------

When(
  phrase("{person}'s browser reads their organizations without the anti-forgery header"),
  async ({ world }, person: string) => {
    await send(world, "GET", "/api/v1/orgs", { as: await world.person(person), csrf: false })
  },
)

const createFromBrowser = (world: World, person: string, extra: Parameters<typeof send>[3]) =>
  world
    .person(person)
    .then((as) =>
      send(world, "POST", "/api/v1/orgs", { as, body: { name: "From a browser" }, ...extra }),
    )

When(
  phrase("{person}'s browser tries to create an organization without the anti-forgery header"),
  async ({ world }, person: string) => {
    await createFromBrowser(world, person, { csrf: false })
  },
)

When(
  phrase("{person}'s browser tries to create an organization from the website {string}"),
  async ({ world }, person: string, origin: string) => {
    await createFromBrowser(world, person, { headers: { origin } })
  },
)

When(
  phrase("{person}'s browser tries to create an organization from the dashboard itself"),
  async ({ world }, person: string) => {
    await createFromBrowser(world, person, { headers: { origin: world.url } })
  },
)

When(phrase("{person}'s session has passed its expiry"), async ({ world }, person: string) => {
  expire(world, "sessions", "user_id", await userId(world, person))
})

When(phrase("{person} signs out"), async ({ world }, person: string) => {
  const reply = await send(world, "POST", "/auth/logout", { as: await world.person(person) })
  expect(reply.status, reply.text).toBe(200)
})

When(
  phrase("{person} tries to sign out without the anti-forgery header"),
  async ({ world }, person: string) => {
    await send(world, "POST", "/auth/logout", { as: await world.person(person), csrf: false })
  },
)

Then(phrase("{person} is still signed in"), async ({ world }, person: string) => {
  const reply = await world.api(person, "GET", "/me")
  expect(reply.status, reply.text).toBe(200)
})

When(
  phrase("the {kind} {string} is exchanged for a browser session"),
  async ({ world }, name: string) => {
    const credential = keyOf(world, name)
    const reply = await send(world, "POST", "/auth/token-login", {
      headers: { "x-mockingbird-csrf": "1" },
      body: { token: credential.kind === "key" ? credential.key : "" },
    })
    const cookie = reply.headers.get("set-cookie")?.split(";")[0]
    if (cookie) world.people.set("the new session", { kind: "session", cookie })
  },
)

Then(phrase("the new browser session belongs to {person}"), async ({ world }, person: string) => {
  const reply = await world.api("the new session", "GET", "/me")
  expect(reply.body).toMatchObject({ kind: "user", user: { email: world.email(person) } })
})

Then(phrase("{person} belongs to no organizations"), async ({ world }, person: string) => {
  const { data } = await world.must<{ data: unknown[] }>(person, "GET", "/orgs")
  expect(data).toEqual([])
})

// ---- who may do what -----------------------------------------------------------------------

/** Someone in the organization other than the actor and its owners, to be acted upon. */
async function teammate(world: World, actor: string) {
  const org = first(world, "org_").id
  const found = (await membersOf(world, org)).find(
    (member) => member.role !== "owner" && member.email !== world.email(actor),
  )
  if (!found) throw new Error("The scenario has no teammate to act on")
  return { org, userId: found.userId }
}

/**
 * Everything a role can be asked to do, in the words the features use. Each acts on the first
 * organization, project and fleet the scenario set up, and on the emulator named "mail".
 */
const ATTEMPTS: Record<string, (world: World, actor: string) => Promise<unknown>> = {
  "view the organization": (world, actor) =>
    world.api(actor, "GET", `/orgs/${first(world, "org_").id}`),
  "list the members": (world, actor) =>
    world.api(actor, "GET", `/orgs/${first(world, "org_").id}/members`),
  "list the projects": (world, actor) =>
    world.api(actor, "GET", `/orgs/${first(world, "org_").id}/projects`),
  "view the project": (world, actor) =>
    world.api(actor, "GET", `/projects/${first(world, "prj_").id}`),
  "list the fleets": (world, actor) =>
    world.api(actor, "GET", `/projects/${first(world, "prj_").id}/fleets`),
  "view the fleet": (world, actor) => world.api(actor, "GET", `/fleets/${first(world, "flt_").id}`),

  "create a project": (world, actor) =>
    world.api(actor, "POST", `/orgs/${first(world, "org_").id}/projects`, { name: "Attempted" }),
  "rename the project": (world, actor) =>
    world.api(actor, "PATCH", `/projects/${first(world, "prj_").id}`, { name: "Renamed" }),
  "create a fleet": (world, actor) =>
    world.api(actor, "POST", `/projects/${first(world, "prj_").id}/fleets`, { name: "Attempted" }),
  "rename the fleet": (world, actor) =>
    world.api(actor, "PATCH", `/fleets/${first(world, "flt_").id}`, { name: "Renamed" }),
  "change who can call the fleet": (world, actor) =>
    world.api(actor, "PATCH", `/fleets/${first(world, "flt_").id}`, { access: "key" }),
  "add an emulator": (world, actor) =>
    world.api(actor, "PUT", `/fleets/${first(world, "flt_").id}/emulators/attempted`, {
      target: "resend",
    }),
  "reconfigure an emulator": (world, actor) =>
    world.api(actor, "PATCH", `/fleets/${first(world, "flt_").id}/emulators/mail`, {
      durability: "ephemeral",
    }),
  "remove an emulator": (world, actor) =>
    world.api(actor, "DELETE", `/fleets/${first(world, "flt_").id}/emulators/mail`),
  "delete the fleet": (world, actor) =>
    world.api(actor, "DELETE", `/fleets/${first(world, "flt_").id}`),

  "delete the project": (world, actor) =>
    world.api(actor, "DELETE", `/projects/${first(world, "prj_").id}`),
  "rename the organization": (world, actor) =>
    world.api(actor, "PATCH", `/orgs/${first(world, "org_").id}`, { name: "Renamed" }),
  "invite someone": (world, actor) =>
    world.api(actor, "POST", `/orgs/${first(world, "org_").id}/invites`, {
      email: world.email("newcomer"),
    }),
  "list the pending invites": (world, actor) =>
    world.api(actor, "GET", `/orgs/${first(world, "org_").id}/invites`),
  "revoke an invite": async (world, actor) => {
    const org = first(world, "org_").id
    const invite = await world.must(await ownerOf(world, org), "POST", `/orgs/${org}/invites`, {
      email: world.email("newcomer"),
    })
    return world.api(actor, "DELETE", `/orgs/${org}/invites/${invite.id}`)
  },
  "create an API key": (world, actor) =>
    world.api(actor, "POST", `/orgs/${first(world, "org_").id}/api-keys`, { name: "attempted" }),
  "list the API keys": (world, actor) =>
    world.api(actor, "GET", `/orgs/${first(world, "org_").id}/api-keys`),
  "revoke an API key": async (world, actor) => {
    const org = first(world, "org_").id
    const key = await world.must(await ownerOf(world, org), "POST", `/orgs/${org}/api-keys`, {
      name: "to be revoked",
    })
    return world.api(actor, "DELETE", `/orgs/${org}/api-keys/${key.id}`)
  },
  "read the audit log": (world, actor) =>
    world.api(actor, "GET", `/orgs/${first(world, "org_").id}/audit`),
  "change a teammate's role": async (world, actor) => {
    const target = await teammate(world, actor)
    return world.api(actor, "PATCH", `/orgs/${target.org}/members/${target.userId}`, {
      role: "viewer",
    })
  },
  "remove a teammate": async (world, actor) => {
    const target = await teammate(world, actor)
    return world.api(actor, "DELETE", `/orgs/${target.org}/members/${target.userId}`)
  },

  "make a teammate an owner": async (world, actor) => {
    const target = await teammate(world, actor)
    return world.api(actor, "PATCH", `/orgs/${target.org}/members/${target.userId}`, {
      role: "owner",
    })
  },
  "delete the organization": (world, actor) =>
    world.api(actor, "DELETE", `/orgs/${first(world, "org_").id}`),
}

When(
  phrase("{actor} attempts to {options}", Object.keys(ATTEMPTS)),
  async ({ world }, actor: string, action: string) => {
    await ATTEMPTS[action]?.(world, who(actor))
  },
)

const OUTCOMES: Record<string, { status: number; code?: string }> = {
  allowed: { status: 200 },
  forbidden: { status: 403, code: "forbidden" },
  "not found": { status: 404, code: "not_found" },
  "refused for lack of credentials": { status: 401, code: "unauthorized" },
}

Then(
  phrase("the attempt is {options}", Object.keys(OUTCOMES)),
  async ({ world }, outcome: string) => {
    const expected = OUTCOMES[outcome]
    if (outcome === "allowed") expect(world.last?.status, world.last?.text).toBeLessThan(300)
    else {
      expect(world.last?.status, world.last?.text).toBe(expected?.status)
      expect(world.errorCode).toBe(expected?.code)
    }
  },
)
