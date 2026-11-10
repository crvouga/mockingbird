/**
 * Steps for calling the emulators of a fleet: the people and fleets a scenario starts from,
 * emails sent and read back through the Resend emulator, who is let in, and what each host
 * serves. Durability, limits, abuse protection and operator steps are in the sibling
 * `fleets-*.steps.ts` files; helpers are in `specs/support/fleets.ts`.
 */
import { expect } from "@playwright/test"
import { createBdd, type DataTable } from "playwright-bdd"
import { test } from "../support/fixtures.js"
import {
  allEmails,
  createFleet,
  currentFleet,
  dashboardHost,
  type EmulatorInput,
  ensurePerson,
  type FleetView,
  fleetOf,
  lastReply,
  onHost,
  presenting,
  RESEND_KEY,
  readEmail,
  replicaUrls,
  STRIPE_KEY,
  secondReplica,
  sendEmail,
  soleEmulator,
  toReply,
} from "../support/fleets.js"
import { startStack } from "../support/stack.js"
import type { Reply, World } from "../support/world.js"
import { Given, Then, When } from "./common.steps.js"

const { Before } = createBdd(test)

const FLEET_HOST = "fleets.example.test"

const emulatorsFrom = (table: DataTable): Record<string, EmulatorInput> =>
  Object.fromEntries(
    table
      .hashes()
      .map((row) => [
        row.name as string,
        { target: row.target as string, ...(row.durability ? { durability: row.durability } : {}) },
      ]),
  )

export const createCustomer = async (world: World, fleetName: string, emulator: string) => {
  const reply = await world.emulator(
    fleetOf(world, fleetName).slug,
    emulator,
    "POST",
    "/v1/customers",
    {
      headers: { ...STRIPE_KEY, "content-type": "application/x-www-form-urlencoded" },
      body: "email=customer%40example.test",
    },
  )
  const id = (reply.body as { id?: string } | undefined)?.id
  if (reply.status === 200 && id) world.things.set("@customer", { id, fleet: fleetName, emulator })
  return reply
}

const expectRead = async (reply: Promise<Reply>, found: boolean) => {
  const { status, text } = await reply
  expect(status, text).toBe(found ? 200 : 404)
}

// ---- where a scenario starts ---------------------------------------------------------------

// Scenarios here start servers, replicas and restarts of their own; on a busy machine that can
// take most of the default minute before the behaviour under test has even begun.
Before({ tags: "@fleets" }, async ({ $testInfo }) => {
  $testInfo.setTimeout(180_000)
})

Given("a deployment of its own for this scenario", async ({ world, ownStacks }) => {
  const stack = await startStack()
  ownStacks.push(stack)
  world.stack = stack
})

Given("a second replica is running", async ({ world, ownStacks }) => {
  if (!ownStacks.includes(world.stack))
    throw new Error("Start replicas only on a deployment the scenario owns")
  await secondReplica(world)
})

Given("{word} is known to the service", async ({ world }, person: string) => {
  await ensurePerson(world, person)
})

Given(
  "{word} has an open fleet {string} with a(n) {word} Resend emulator",
  async ({ world }, person: string, name: string, durability: string) => {
    await createFleet(world, person, name, {
      emulators: { resend: { target: "resend", durability } },
    })
  },
)

Given(
  "{word} has a key-protected fleet {string} with a(n) {word} Resend emulator",
  async ({ world }, person: string, name: string, durability: string) => {
    await createFleet(world, person, name, {
      access: "key",
      emulators: { resend: { target: "resend", durability } },
    })
  },
)

Given(
  "{word} has an open fleet {string} with a Resend emulator of unstated durability",
  async ({ world }, person: string, name: string) => {
    await createFleet(world, person, name, { emulators: { resend: { target: "resend" } } })
  },
)

Given(
  "{word} has an open fleet {string} with these emulators:",
  async ({ world }, person: string, name: string, table: DataTable) => {
    await createFleet(world, person, name, { emulators: emulatorsFrom(table) })
  },
)

Given(
  "{word} adds a Resend emulator {string} to {string}",
  async ({ world }, person: string, emulator: string, fleetName: string) => {
    const fleet = fleetOf(world, fleetName)
    const updated = await world.must<FleetView>(
      person,
      "PUT",
      `/fleets/${fleet.id}/emulators/${emulator}`,
      { target: "resend" },
    )
    world.things.set(fleetName, { ...updated, owner: fleet.owner })
  },
)

// ---- sending -------------------------------------------------------------------------------

const sent = async (reply: Promise<Reply>) => {
  const { status, text } = await reply
  expect(status, text).toBe(200)
}

When("an SDK sends an email through {string}", async ({ world }, fleet: string) => {
  await sendEmail(world, fleet)
})
Given("an SDK has sent an email through {string}", async ({ world }, fleet: string) => {
  await sent(sendEmail(world, fleet))
})

When(
  "an SDK sends an email through {string} in the namespace {string}",
  async ({ world }, fleet: string, namespace: string) => {
    await sendEmail(world, fleet, { namespace })
  },
)
Given(
  "an SDK has sent an email through {string} in the namespace {string}",
  async ({ world }, fleet: string, namespace: string) => {
    await sent(sendEmail(world, fleet, { namespace }))
  },
)

When(
  "an SDK sends an email through the {string} emulator of {string}",
  async ({ world }, emulator: string, fleet: string) => {
    await sendEmail(world, fleet, { emulator })
  },
)
Given(
  "an SDK has sent an email through the {string} emulator of {string}",
  async ({ world }, emulator: string, fleet: string) => {
    await sent(sendEmail(world, fleet, { emulator }))
  },
)

When(
  "an SDK sends an email through {string} presenting {}",
  async ({ world }, fleet: string, credential: string) => {
    await sendEmail(world, fleet, { headers: await presenting(world, fleet, credential) })
  },
)

When(
  "an SDK sends an email through {string} without the vendor's API key",
  async ({ world }, fleet: string) => {
    await sendEmail(world, fleet, { headers: { authorization: "" } })
  },
)

When(
  "an SDK sends an email through {string} with the vendor key {string}",
  async ({ world }, fleet: string, key: string) => {
    await sendEmail(world, fleet, { headers: { authorization: `Bearer ${key}` } })
  },
)

When(
  "an SDK sends an email through {string} with the header {string}",
  async ({ world }, fleet: string, header: string) => {
    await sendEmail(world, fleet, { headers: headerFrom(header) })
  },
)

/** `"name: value"` as a feature writes a header. */
export const headerFrom = (text: string): Record<string, string> => {
  const at = text.indexOf(":")
  return { [text.slice(0, at).trim()]: text.slice(at + 1).trim() }
}

const sendMany = async (world: World, count: number, fleet: string) => {
  const replies: Reply[] = []
  for (let index = 0; index < count; index++) replies.push(await sendEmail(world, fleet))
  world.things.set("@replies", { list: replies })
  return replies
}
When("SDKs send {int} emails through {string}", async ({ world }, count: number, fleet: string) => {
  await sendMany(world, count, fleet)
})
Given(
  "SDKs have sent {int} emails through {string}",
  async ({ world }, count: number, fleet: string) => {
    for (const reply of await sendMany(world, count, fleet))
      expect(reply.status, reply.text).toBe(200)
  },
)

When(
  "SDKs send {int} emails through {string}, taking turns between the two replicas",
  async ({ world }, count: number, fleet: string) => {
    const urls = await replicaUrls(world)
    for (let index = 0; index < count; index++)
      await sent(sendEmail(world, fleet, { base: urls[index % urls.length] as string }))
  },
)

When(
  "SDKs send {int} emails through {string}, to both replicas at the same moment",
  async ({ world }, count: number, fleet: string) => {
    const urls = await replicaUrls(world)
    const replies = await Promise.all(
      Array.from({ length: count }, (_, index) =>
        sendEmail(world, fleet, { base: urls[index % urls.length] as string }),
      ),
    )
    for (const reply of replies) expect(reply.status, reply.text).toBe(200)
  },
)

When(
  "a Stripe SDK creates a customer through the {string} emulator of {string}",
  async ({ world }, emulator: string, fleet: string) => {
    await createCustomer(world, fleet, emulator)
  },
)

Then("the email is accepted", async ({ world }) => {
  expect(world.last?.status, world.last?.text).toBe(200)
  expect((lastReply(world).body as { id?: unknown }).id).toEqual(expect.any(String))
})

Then("every one of them is accepted", async ({ world }) => {
  const replies = world.thing<{ list: Reply[] }>("@replies").list
  expect(replies.map((reply) => reply.status)).toEqual(replies.map(() => 200))
})

// ---- reading back --------------------------------------------------------------------------

Then("the email can be read back", async ({ world }) => {
  await expectRead(readEmail(world), true)
})

Then(
  "the email can be read back in the namespace {string}",
  async ({ world }, namespace: string) => {
    await expectRead(readEmail(world, { namespace }), true)
  },
)
Then(
  "the email cannot be read back in the namespace {string}",
  async ({ world }, namespace: string) => {
    await expectRead(readEmail(world, { namespace }), false)
  },
)
Then("the email cannot be read back without a namespace", async ({ world }) => {
  await expectRead(readEmail(world, { namespace: null }), false)
})

Then(
  "the email can be read back from the {string} emulator of {string}",
  async ({ world }, emulator: string, fleet: string) => {
    await expectRead(readEmail(world, { fleet, emulator }), true)
  },
)
Then(
  "the email cannot be read back from the {string} emulator of {string}",
  async ({ world }, emulator: string, fleet: string) => {
    await expectRead(readEmail(world, { fleet, emulator }), false)
  },
)
Then("the email cannot be read back from the fleet {string}", async ({ world }, fleet: string) => {
  await expectRead(readEmail(world, { fleet }), false)
})

Then("the email can be read back through the second replica", async ({ world }) => {
  await expectRead(readEmail(world, { base: (await secondReplica(world)).url }), true)
})
Then("the email cannot be read back through the second replica", async ({ world }) => {
  await expectRead(readEmail(world, { base: (await secondReplica(world)).url }), false)
})

Then(
  "every one of the {int} emails can be read back through either replica",
  async ({ world }, count: number) => {
    const emails = allEmails(world)
    expect(emails).toHaveLength(count)
    expect(new Set(emails.map((email) => email.id)).size).toBe(count)
    for (const base of await replicaUrls(world))
      for (const email of emails) await expectRead(readEmail(world, { email, base }), true)
  },
)

// ---- discovery and what is not there -------------------------------------------------------

type Discovery = {
  fleet: string
  emulators: Record<string, { target: string; durability: string; url: string }>
}

When("anyone opens the URL of {string}", async ({ world }, fleet: string) => {
  world.last = await toReply(await fetch(`${world.url}/f/${fleetOf(world, fleet).slug}`))
})

Then("the discovery document lists these emulators:", async ({ world }, table: DataTable) => {
  const document = world.last?.body as Discovery
  expect(document.fleet).toBe(currentFleet(world).slug)
  const byName = (left: { name?: string }, right: { name?: string }) =>
    (left.name ?? "").localeCompare(right.name ?? "")
  expect(
    Object.entries(document.emulators)
      .map(([name, emulator]) => ({
        name,
        target: emulator.target,
        durability: emulator.durability,
      }))
      .sort(byName),
  ).toEqual(table.hashes().sort(byName))
})

Then("each listed URL is the fleet's URL followed by the emulator's name", async ({ world }) => {
  const fleet = currentFleet(world)
  expect(fleet.url).toBe(`${world.url}/f/${fleet.slug}`)
  for (const [name, emulator] of Object.entries((lastReply(world).body as Discovery).emulators)) {
    expect(emulator.url).toBe(`${fleet.url}/${name}`)
    expect(emulator.url).toBe(fleet.emulators[name]?.url)
  }
})

When("an SDK calls a fleet nobody has created", async ({ world }) => {
  await world.emulator(world.slug("nobodys"), "resend", "POST", "/emails", {
    headers: RESEND_KEY,
    body: {},
  })
})

When(
  "an SDK calls the {string} emulator of {string}",
  async ({ world }, emulator: string, fleet: string) => {
    await sendEmail(world, fleet, { emulator })
  },
)
Given(
  "an SDK has already called the {string} emulator of {string} in vain",
  async ({ world }, emulator: string, fleet: string) => {
    expect((await sendEmail(world, fleet, { emulator })).status).toBe(404)
  },
)

// ---- the vendor's Authorization header -----------------------------------------------------

Then(
  "the emulator answers with the vendor's own {string} error",
  async ({ world }, name: string) => {
    expect(world.last?.status, world.last?.text).toBe(401)
    // Resend's error shape, not Mockingbird's `{error: {code, message}}`.
    expect(world.last?.body).toMatchObject({ statusCode: 401, name })
    expect(world.errorCode).toBeUndefined()
  },
)

Given(
  "the emulator of {string} files the vendor key {string} under the namespace {string}",
  async ({ world }, fleetName: string, key: string, namespace: string) => {
    const fleet = fleetOf(world, fleetName)
    const reply = await world.emulator(
      fleet.slug,
      soleEmulator(fleet),
      "PUT",
      "/__admin/credentials",
      {
        headers: await presenting(world, fleetName, "a member key"),
        body: { credentials: { [key]: namespace } },
      },
    )
    expect(reply.status, reply.text).toBeLessThan(300)
  },
)

// ---- admin routes --------------------------------------------------------------------------

When(
  "the admin routes of the {string} emulator are called presenting {}",
  async ({ world }, fleetName: string, credential: string) => {
    const fleet = fleetOf(world, fleetName)
    await world.emulator(fleet.slug, soleEmulator(fleet), "GET", "/__admin/health", {
      headers: await presenting(world, fleetName, credential),
    })
  },
)

Then("the emulator's admin routes answer", async ({ world }) => {
  expect(world.last?.status, world.last?.text).toBe(200)
  expect(world.last?.body).toMatchObject({ status: "ok", service: "resend" })
})

// ---- isolation from the dashboard ----------------------------------------------------------

const policy = (world: World) => world.last?.headers.get("content-security-policy") ?? ""

Then("the response is sandboxed away from the dashboard", async ({ world }) => {
  expect(policy(world)).toMatch(/^sandbox\b/)
  // An emulator page may run scripts, but never as the same origin as the dashboard.
  expect(policy(world)).not.toContain("allow-same-origin")
})

Then("the response forbids guessing its content type", async ({ world }) => {
  expect(world.last?.headers.get("x-content-type-options")).toBe("nosniff")
})

Then("the response is not sandboxed", async ({ world }) => {
  expect(policy(world)).not.toContain("sandbox")
})

When("a browser opens the dashboard", async ({ world }) => {
  world.last = await toReply(await fetch(`${world.url}/`))
})

Then("the response is a dashboard page that may not be framed", async ({ world }) => {
  expect(world.last?.headers.get("content-type")).toContain("text/html")
  expect(policy(world)).toContain("frame-ancestors 'none'")
  expect(policy(world)).not.toContain("sandbox")
})

Then("the URL of {string} is on {string}", async ({ world }, fleetName: string, origin: string) => {
  const fleet = fleetOf(world, fleetName)
  expect(fleet.url).toBe(`${origin}/f/${fleet.slug}`)
})

Then("the URL of its emulator is on {string}", async ({ world }, origin: string) => {
  const fleet = currentFleet(world)
  const name = soleEmulator(fleet)
  expect(fleet.emulators[name]?.url).toBe(`${origin}/f/${fleet.slug}/${name}`)
})

When("the fleet {string} is opened on the fleet host", async ({ world }, fleet: string) => {
  await onHost(world, FLEET_HOST, `/f/${fleetOf(world, fleet).slug}`)
})
When("the fleet {string} is opened on the dashboard host", async ({ world }, fleet: string) => {
  await onHost(world, dashboardHost(world), `/f/${fleetOf(world, fleet).slug}`)
})
When("{string} is requested on the fleet host", async ({ world }, path: string) => {
  await onHost(world, FLEET_HOST, path)
})
When("{string} is requested on the dashboard host", async ({ world }, path: string) => {
  await onHost(world, dashboardHost(world), path)
})

When(
  "an SDK sends an email through {string} on the fleet host",
  async ({ world }, fleetName: string) => {
    const fleet = fleetOf(world, fleetName)
    await onHost(world, FLEET_HOST, `/f/${fleet.slug}/${soleEmulator(fleet)}/emails`, {
      method: "POST",
      headers: { ...RESEND_KEY, "content-type": "application/json" },
      body: JSON.stringify({
        from: "sender@example.test",
        to: "receiver@example.test",
        subject: "Hello",
        html: "<p>Hello</p>",
      }),
    })
  },
)
