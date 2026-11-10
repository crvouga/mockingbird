/**
 * Steps for the operator of the service: who reaches the operator API, quota overrides for one
 * organization, and suspending and reinstating an organization.
 */
import { expect } from "@playwright/test"
import {
  currentFleet,
  dashboardSession,
  ensureOrg,
  ensurePerson,
  eventually,
  type FleetView,
  fleetOf,
  lastReply,
  orgOf,
  secondReplica,
  sendEmail,
} from "../support/fleets.js"
import { OPERATOR_TOKEN } from "../support/stack.js"
import type { Credential, World } from "../support/world.js"
import { Given, Then, When } from "./common.steps.js"

type AdminOrg = {
  id: string
  suspended: string | null
  limits: Record<string, number>
  limitOverrides: Record<string, number>
  requestsThisMonth: number
}

const QUOTAS = [
  "projectsPerOrg",
  "fleetsPerOrg",
  "emulatorsPerFleet",
  "membersPerOrg",
  "apiKeysPerOrg",
  "stateBytes",
  "requestsPerMonth",
  "fleetRequestsPerMinute",
]

// ---- who reaches the operator API ----------------------------------------------------------

When("the operator API is called presenting {}", async ({ world }, description: string) => {
  const owner = () => currentFleet(world).owner
  let credential: Credential | "operator" | "anonymous"
  switch (description) {
    case "the operator token":
      credential = "operator"
      break
    case "no credential":
      credential = "anonymous"
      break
    case "the dashboard session of an owner":
      credential = { kind: "session", cookie: await dashboardSession(world, owner()) }
      break
    case "the personal token of an owner":
      credential = await ensurePerson(world, owner())
      break
    case "an organization's admin key": {
      const { key } = await world.must<{ key: string }>(
        owner(),
        "POST",
        `/orgs/${orgOf(world, owner()).id}/api-keys`,
        { name: "Admin key", role: "admin" },
      )
      credential = { kind: "key", key }
      break
    }
    case "the operator token with one character changed":
      credential = { kind: "key", key: `${OPERATOR_TOKEN.slice(0, -1)}X` }
      break
    default:
      throw new Error(`No credential is described as "${description}"`)
  }
  await world.api(credential, "GET", "/admin/orgs")
})

When(
  "{word} tries to suspend her own organization through the operator API",
  async ({ world }, person: string) => {
    const org = await ensureOrg(world, person)
    await world.api(person, "PATCH", `/admin/orgs/${org.id}`, { suspended: "by a tenant" })
    const status = world.last
    // Whatever was answered, the organization must not have been suspended.
    const { data } = await world.must<{ data: AdminOrg[] }>("operator", "GET", "/admin/orgs")
    expect(data.find((entry) => entry.id === org.id)?.suspended).toBeNull()
    world.last = status
  },
)

When("the operator token is presented to list organizations as a user would", async ({ world }) => {
  await world.api("operator", "GET", "/orgs")
})

// ---- seeing every organization -------------------------------------------------------------

When("the operator lists every organization", async ({ world }) => {
  await world.api("operator", "GET", "/admin/orgs")
})

const listed = (world: World, person: string) => {
  expect(world.last?.status, world.last?.text).toBe(200)
  const entry = (lastReply(world).body as { data: AdminOrg[] }).data.find(
    (candidate) => candidate.id === orgOf(world, person).id,
  )
  if (!entry) throw new Error(`${person}'s organization is not in the operator's list`)
  return entry
}

Then(
  "the list shows {word}'s organization with {int} emulator requests this month",
  async ({ world }, person: string, count: number) => {
    expect(listed(world, person).requestsThisMonth).toBe(count)
  },
)

Then(
  "the list shows the quotas that apply to {word}'s organization",
  async ({ world }, person: string) => {
    const entry = listed(world, person)
    expect(Object.keys(entry.limits).sort()).toEqual([...QUOTAS].sort())
    for (const value of Object.values(entry.limits)) expect(value).toBeGreaterThanOrEqual(0)
    expect(entry.limitOverrides).toEqual({})
  },
)

Then(
  "the list shows {word}'s organization as suspended for {string}",
  async ({ world }, person: string, reason: string) => {
    expect(listed(world, person).suspended).toBe(reason)
  },
)

// ---- quota overrides -----------------------------------------------------------------------

const override = async (world: World, person: string, quota: string, value: unknown) =>
  world.api("operator", "PATCH", `/admin/orgs/${(await ensureOrg(world, person)).id}`, {
    limits: { [quota]: value },
  })

When(
  "the operator sets the {string} quota of {word}'s organization to {int}",
  async ({ world }, quota: string, person: string, value: number) => {
    await override(world, person, quota, value)
  },
)
Given(
  "the operator has set the {string} quota of {word}'s organization to {int}",
  async ({ world }, quota: string, person: string, value: number) => {
    const reply = await override(world, person, quota, value)
    expect(reply.status, reply.text).toBe(200)
    expect((reply.body as AdminOrg).limits[quota]).toBe(value)
  },
)

When(
  "the operator tries to set the {string} quota of {word}'s organization to {}",
  async ({ world }, quota: string, person: string, value: string) => {
    await override(world, person, quota, JSON.parse(value))
  },
)

When(
  "the operator removes the {string} override of {word}'s organization",
  async ({ world }, quota: string, person: string) => {
    await override(world, person, quota, null)
  },
)

Then("{word}'s organization has no quota overrides", async ({ world }, person: string) => {
  const { data } = await world.must<{ data: AdminOrg[] }>("operator", "GET", "/admin/orgs")
  expect(data.find((entry) => entry.id === orgOf(world, person).id)?.limitOverrides).toEqual({})
})

Then(
  "the {string} quota of {word}'s organization is the same as {word}'s",
  async ({ world }, quota: string, person: string, other: string) => {
    const limitOf = async (who: string) =>
      (
        await world.must<{ limits: Record<string, number> }>(
          who,
          "GET",
          `/orgs/${orgOf(world, who).id}/usage`,
        )
      ).limits[quota]
    expect(await limitOf(person)).toBe(await limitOf(other))
    expect(await limitOf(person)).toEqual(expect.any(Number))
  },
)

When("the operator sets a quota of an organization that does not exist", async ({ world }) => {
  await world.api("operator", "PATCH", "/admin/orgs/org_doesnotexist0000000", {
    limits: { projectsPerOrg: 1 },
  })
})

// ---- suspension ----------------------------------------------------------------------------

const suspend = async (world: World, person: string, suspended: string | null) =>
  world.api("operator", "PATCH", `/admin/orgs/${(await ensureOrg(world, person)).id}`, {
    suspended,
  })

When(
  "the operator suspends {word}'s organization for {string}",
  async ({ world }, person: string, reason: string) => {
    await suspend(world, person, reason)
  },
)
Given(
  "the operator has suspended {word}'s organization for {string}",
  async ({ world }, person: string, reason: string) => {
    const reply = await suspend(world, person, reason)
    expect(reply.status, reply.text).toBe(200)
    expect((reply.body as AdminOrg).suspended).toBe(reason)
  },
)

When("the operator reinstates {word}'s organization", async ({ world }, person: string) => {
  await suspend(world, person, null)
})

When("{word} looks at the fleet {string}", async ({ world }, person: string, fleet: string) => {
  const reply = await world.api(person, "GET", `/fleets/${fleetOf(world, fleet).id}`)
  if (reply.status === 200) expect((reply.body as FleetView).slug).toBe(fleetOf(world, fleet).slug)
})

// ---- replicas ------------------------------------------------------------------------------

const throughReplica = async (world: World, fleet: string) =>
  sendEmail(world, fleet, { base: (await secondReplica(world)).url })

Given("the second replica is already serving {string}", async ({ world }, fleet: string) => {
  const reply = await throughReplica(world, fleet)
  expect(reply.status, reply.text).toBe(200)
})

Then(
  "within {int} seconds the second replica refuses {string} as {string}",
  async ({ world }, seconds: number, fleet: string, code: string) => {
    await eventually(`the second replica refuses ${fleet} as ${code}`, seconds, async () => {
      const reply = await throughReplica(world, fleet)
      return reply.status === 403 && world.errorCode === code
    })
  },
)

Then(
  "within {int} seconds the second replica serves {string} again",
  async ({ world }, seconds: number, fleet: string) => {
    await eventually(`the second replica serves ${fleet}`, seconds, async () => {
      return (await throughReplica(world, fleet)).status === 200
    })
  },
)
