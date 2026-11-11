/**
 * Steps for quotas and rate limits: growing an organization past what it may hold, reading
 * its usage, and spending a budget until the service refuses.
 */
import { expect } from "@playwright/test"
import type { DataTable } from "playwright-bdd"
import {
  ensureOrg,
  ensurePerson,
  ensureProject,
  eventually,
  fleetOf,
  forwardedFor,
  incompressible,
  lastReply,
  presenting,
  retryAfter,
  sendEmail,
  sleep,
  soleEmulator,
  storedState,
  toReply,
  untilRefused,
} from "../support/fleets.js"
import type { Reply, World } from "../support/world.js"
import { Given, Then, When } from "./common.steps.js"

// ---- growing past a quota ------------------------------------------------------------------

When("{word} tries to create a second organization", async ({ world }, person: string) => {
  await ensureOrg(world, person)
  await world.api(person, "POST", "/orgs", { name: "Second organization" })
})

When("{word} tries to create a second project", async ({ world }, person: string) => {
  const org = await ensureOrg(world, person)
  await ensureProject(world, person)
  await world.api(person, "POST", `/orgs/${org.id}/projects`, { name: "Second project" })
})

When("{word} tries to create a second fleet", async ({ world }, person: string) => {
  const project = await ensureProject(world, person)
  await world.api(person, "POST", `/projects/${project.id}/fleets`, { name: "Second fleet" })
})

When("{word} tries to create a fleet with two emulators", async ({ world }, person: string) => {
  const project = await ensureProject(world, person)
  await world.api(person, "POST", `/projects/${project.id}/fleets`, {
    name: "Two emulators",
    emulators: { one: { target: "resend" }, two: { target: "resend" } },
  })
})

When(
  "{word} tries to create a fleet with a budget of {int} requests per minute",
  async ({ world }, person: string, requestsPerMinute: number) => {
    const project = await ensureProject(world, person)
    await world.api(person, "POST", `/projects/${project.id}/fleets`, {
      name: "Greedy",
      requestsPerMinute,
    })
  },
)

When(
  "{word} tries to add a second emulator to {string}",
  async ({ world }, person: string, fleet: string) => {
    await world.api(person, "PUT", `/fleets/${fleetOf(world, fleet).id}/emulators/second`, {
      target: "resend",
    })
  },
)

const createKey = async (world: World, person: string, name: string) =>
  world.api(person, "POST", `/orgs/${(await ensureOrg(world, person)).id}/api-keys`, { name })

When("{word} tries to create an API key", async ({ world }, person: string) => {
  await createKey(world, person, "A key")
})

When("{word} tries to create a second API key", async ({ world }, person: string) => {
  const first = await createKey(world, person, "First key")
  expect(first.status, first.text).toBe(201)
  await createKey(world, person, "Second key")
})

const invite = async (world: World, person: string, guest: string) =>
  world.api(person, "POST", `/orgs/${(await ensureOrg(world, person)).id}/invites`, {
    email: world.email(guest),
  })

When("{word} tries to invite a person", async ({ world }, person: string) => {
  await invite(world, person, "guest")
})

When(
  "{word} tries to invite a second person while one is invited",
  async ({ world }, person: string) => {
    const first = await invite(world, person, "firstguest")
    expect(first.status, first.text).toBe(201)
    await invite(world, person, "secondguest")
  },
)

When(
  "{word} tries to rename the fleet {string}",
  async ({ world }, person: string, fleet: string) => {
    await world.api(person, "PATCH", `/fleets/${fleetOf(world, fleet).id}`, { name: "Renamed" })
  },
)

When(
  "{word} tries to reset the emulator of {string}",
  async ({ world }, person: string, fleetName: string) => {
    const fleet = fleetOf(world, fleetName)
    await world.api(person, "POST", `/fleets/${fleet.id}/emulators/${soleEmulator(fleet)}/reset`)
  },
)

When(
  "{word} creates {int} projects in her organization",
  async ({ world }, person: string, count: number) => {
    const org = await ensureOrg(world, person)
    for (let index = 1; index <= count; index++)
      await world.must(person, "POST", `/orgs/${org.id}/projects`, { name: `Project ${index}` })
  },
)

Then("the refusal names the quota {string}", async ({ world }, quota: string) => {
  const error = (
    lastReply(world).body as { error?: { details?: { limit?: string }; message?: string } }
  ).error
  expect(error?.details?.limit, world.last?.text).toBe(quota)
  // The message tells a person the same thing the details tell a program.
  expect(error?.message).toContain(quota)
})

// ---- usage ---------------------------------------------------------------------------------

type Usage = {
  suspended: string | null
  limits: Record<string, number>
  usage: Record<string, number>
  daily: { day: string; requests: number }[]
}
const usage = (world: World) => world.thing<Usage>("@usage")

When("{word} looks at her organization's usage", async ({ world }, person: string) => {
  const org = await ensureOrg(world, person)
  const reply = await world.api(person, "GET", `/orgs/${org.id}/usage`)
  if (reply.status === 200) world.things.set("@usage", reply.body as Usage)
})

const numbers = (table: DataTable) =>
  Object.fromEntries(Object.entries(table.rowsHash()).map(([key, value]) => [key, Number(value)]))

Then("the usage report shows these limits:", async ({ world }, table: DataTable) => {
  expect(usage(world).limits).toMatchObject(numbers(table))
})

Then("the usage report shows this usage:", async ({ world }, table: DataTable) => {
  expect(usage(world).usage).toMatchObject(numbers(table))
})

Then(
  "the usage report shows {int} emulator requests this month",
  async ({ world }, count: number) => {
    expect(usage(world).usage.requestsThisMonth).toBe(count)
  },
)

Then("the usage report shows {int} emulator requests today", async ({ world }, count: number) => {
  // One entry per UTC day; a run that straddles midnight splits the count over two.
  const { daily } = usage(world)
  expect(daily.reduce((sum, day) => sum + day.requests, 0)).toBe(count)
  expect(daily.at(-1)?.day).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  expect(daily.length).toBeLessThanOrEqual(2)
})

Then(
  "the usage report says the organization is suspended for {string}",
  async ({ world }, reason: string) => {
    expect(usage(world).suspended).toBe(reason)
  },
)

// ---- stored state size ---------------------------------------------------------------------

const OVERSIZED = 6000

When("an SDK sends an oversized email through {string}", async ({ world }, fleet: string) => {
  // Keep "the email" pointing at the one sent before, so the scenario can ask after it.
  const before = world.things.get("@email")
  await sendEmail(world, fleet, { html: incompressible(OVERSIZED) })
  if (before) world.things.set("@email", before)
})
Given("an SDK has sent an oversized email through {string}", async ({ world }, fleet: string) => {
  const reply = await sendEmail(world, fleet, { html: incompressible(OVERSIZED) })
  expect(reply.status, reply.text).toBe(200)
})

Then(
  "what is stored for the emulator of {string} is within {int} bytes",
  async ({ world }, fleetName: string, bytes: number) => {
    const fleet = fleetOf(world, fleetName)
    const stored = await storedState(world, fleet, soleEmulator(fleet))
    expect(stored?.bytes).toBeGreaterThan(0)
    expect(stored?.bytes).toBeLessThanOrEqual(bytes)
  },
)

Then("the emulator of {string} still accepts a small email", async ({ world }, fleet: string) => {
  const reply = await sendEmail(world, fleet)
  expect(reply.status, reply.text).toBe(200)
})

Then(
  "within {int} seconds the emulator of {string} refuses calls as {string}",
  async ({ world }, seconds: number, fleet: string, code: string) => {
    await eventually(`${fleet} refuses calls as ${code}`, seconds, async () => {
      const before = world.things.get("@email")
      const reply = await sendEmail(world, fleet)
      if (before) world.things.set("@email", before)
      return world.errorCode === code && reply.status === 507
    })
  },
)

// ---- rate limits: what a refusal and an answer say -----------------------------------------

Then(
  "the refusal reports a budget of {int} per minute with nothing remaining",
  async ({ world }, budget: number) => {
    expect(world.last?.status, world.last?.text).toBe(429)
    expect(world.last?.headers.get("ratelimit-limit")).toBe(String(budget))
    expect(world.last?.headers.get("ratelimit-remaining")).toBe("0")
  },
)

Then("the refusal says how many seconds to wait", async ({ world }) => {
  expect(retryAfter(world.last)).toBeLessThanOrEqual(60)
  expect(world.errorMessage).toContain(`Retry in ${retryAfter(world.last)} s`)
})

Then(
  "the answer reports a budget of {int} per minute and how much remains",
  async ({ world }, budget: number) => {
    expect(world.last?.status, world.last?.text).toBeLessThan(300)
    expect(world.last?.headers.get("ratelimit-limit")).toBe(String(budget))
    const remaining = Number(world.last?.headers.get("ratelimit-remaining"))
    expect(Number.isInteger(remaining)).toBe(true)
    expect(remaining).toBeGreaterThanOrEqual(0)
    expect(remaining).toBeLessThan(budget)
    expect(world.last?.headers.get("retry-after")).toBeNull()
  },
)

When("the caller waits as long as the refusal asked", async ({ world }) => {
  await sleep(retryAfter(world.last) * 1000 + 250)
})

/**
 * A budget trickles back in while a scenario runs, so "is refused" means: has nothing to spare.
 * One call may be served by a token that arrived since the refusal; the calls after it cannot be.
 */
const refusedSoon = async (attempt: () => Promise<Reply>, drain?: () => Promise<unknown>) => {
  let reply = await attempt()
  for (let again = 0; again < 3 && reply.status !== 429; again++) {
    await drain?.()
    reply = await attempt()
  }
  return reply
}

// ---- the control API budget ----------------------------------------------------------------

const whoAmI = (world: World, person: string, address?: string) =>
  world.api(person, "GET", "/me", undefined, address ? { headers: forwardedFor(address) } : {})

When("{word} calls the control API until she is refused", async ({ world }, person: string) => {
  await ensurePerson(world, person)
  await untilRefused(world, () => whoAmI(world, person))
})

When("{word} calls the control API once", async ({ world }, person: string) => {
  await ensurePerson(world, person)
  await whoAmI(world, person)
})

Then("{word} is still served by the control API", async ({ world }, person: string) => {
  const reply = await whoAmI(world, person)
  expect(reply.status, reply.text).toBe(200)
})

Then(
  "{word} is still served by the control API from {string}",
  async ({ world }, person: string, address: string) => {
    const reply = await whoAmI(world, person, address)
    expect(reply.status, reply.text).toBe(200)
  },
)

When(
  "{word} calls the control API {int} times from {string}",
  async ({ world }, person: string, count: number, address: string) => {
    const replies: Reply[] = []
    for (let index = 0; index < count; index++) replies.push(await whoAmI(world, person, address))
    world.things.set("@replies", { list: replies })
  },
)

const publicConfig = (world: World, address: string) =>
  world.api("anonymous", "GET", "/config", undefined, { headers: forwardedFor(address) })

When(
  "an anonymous caller at {string} calls the control API until refused",
  async ({ world }, address: string) => {
    await untilRefused(world, () => publicConfig(world, address))
  },
)

Then(
  "an anonymous caller at {string} is still served by the control API",
  async ({ world }, address: string) => {
    const reply = await publicConfig(world, address)
    expect(reply.status, reply.text).toBe(200)
  },
)

// ---- sign-in attempts and rejected credentials ---------------------------------------------

let visitors = 0
const signIn = async (world: World, address: string) => {
  world.last = await toReply(
    await fetch(`${world.url}/auth/dev-login`, {
      method: "POST",
      headers: {
        "x-mockingbird-csrf": "1",
        "content-type": "application/json",
        ...forwardedFor(address),
      },
      body: JSON.stringify({ email: world.email(`visitor${visitors++}`) }),
    }),
  )
  return world.last
}

When(
  "someone at {string} attempts to sign in until refused",
  async ({ world }, address: string) => {
    await untilRefused(world, () => signIn(world, address))
  },
)

Then("someone at {string} can sign in", async ({ world }, address: string) => {
  const reply = await signIn(world, address)
  expect(reply.status, reply.text).toBe(200)
  expect(reply.headers.get("set-cookie")).toBeTruthy()
})

const REJECTED_KEY = "mbf_o_this-key-was-never-issued"
const rejectedCredential = (world: World, address: string) =>
  world.api({ kind: "key", key: REJECTED_KEY }, "GET", "/me", undefined, {
    headers: forwardedFor(address),
  })

When(
  "someone at {string} presents rejected credentials to the control API until refused",
  async ({ world }, address: string) => {
    await untilRefused(world, () => rejectedCredential(world, address), {
      expected: (reply) => reply.status === 401,
    })
  },
)

Then(
  "even {word}'s valid credential is refused as {string} from {string}",
  async ({ world }, person: string, code: string, address: string) => {
    const reply = await refusedSoon(
      () => whoAmI(world, person, address),
      () => rejectedCredential(world, address),
    )
    expect(reply.status, reply.text).toBe(429)
    expect(world.errorCode).toBe(code)
  },
)

const rejectedKey = (world: World, fleet: string, address: string) =>
  sendEmail(world, fleet, {
    headers: { "x-mockingbird-api-key": REJECTED_KEY, ...forwardedFor(address) },
  })

When(
  "an SDK at {string} presents rejected keys to {string} until refused",
  async ({ world }, address: string, fleet: string) => {
    await untilRefused(world, () => rejectedKey(world, fleet, address), {
      expected: (reply) => reply.status === 401,
    })
  },
)

Then(
  "even a member key for {string} is refused as {string} from {string}",
  async ({ world }, fleet: string, code: string, address: string) => {
    const key = await presenting(world, fleet, "a member key")
    const reply = await refusedSoon(
      () => sendEmail(world, fleet, { headers: { ...key, ...forwardedFor(address) } }),
      () => rejectedKey(world, fleet, address),
    )
    expect(reply.status, reply.text).toBe(429)
    expect(world.errorCode).toBe(code)
  },
)

// ---- emulator calls per client address and per fleet ---------------------------------------

When(
  "an SDK whose forwarding chain is {string} calls {string} until refused",
  async ({ world }, chain: string, fleet: string) => {
    await untilRefused(world, () => sendEmail(world, fleet, { headers: forwardedFor(chain) }))
  },
)

Then(
  "an SDK whose forwarding chain is {string} is refused by {string}",
  async ({ world }, chain: string, fleet: string) => {
    const reply = await refusedSoon(() => sendEmail(world, fleet, { headers: forwardedFor(chain) }))
    expect(reply.status, reply.text).toBe(429)
    expect(world.errorCode).toBe("rate_limited")
  },
)

Then(
  "an SDK whose forwarding chain is {string} is served by {string}",
  async ({ world }, chain: string, fleet: string) => {
    const reply = await sendEmail(world, fleet, { headers: forwardedFor(chain) })
    expect(reply.status, reply.text).toBe(200)
  },
)

When("an SDK calls {string} until refused", async ({ world }, fleet: string) => {
  await untilRefused(world, () => sendEmail(world, fleet))
})

When(
  "{word} sets the budget of {string} to {int} requests per minute",
  async ({ world }, person: string, fleet: string, requestsPerMinute: number) => {
    await world.api(person, "PATCH", `/fleets/${fleetOf(world, fleet).id}`, { requestsPerMinute })
  },
)
