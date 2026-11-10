/**
 * Steps for abuse protection: control headers from callers who may not send them, slow and
 * simultaneous requests, webhook delivery, and oversized bodies.
 */
import { createServer, type Server as HttpServer } from "node:http"
import { expect } from "@playwright/test"
import { createBdd } from "playwright-bdd"
import { test } from "../support/fixtures.js"
import {
  announceBody,
  fleetOf,
  presenting,
  readEmail,
  STRIPE_KEY,
  sendEmail,
  sleep,
} from "../support/fleets.js"
import type { Reply, World } from "../support/world.js"
import { Given, Then, When } from "./common.steps.js"
import { headerFrom } from "./fleets.steps.js"

const { After } = createBdd(test)

// ---- control headers -----------------------------------------------------------------------

When(
  "a caller presenting {} reads the email back with the header {string}",
  async ({ world }, credential: string, header: string) => {
    const fleet = world.thing<{ fleet: string }>("@email").fleet
    await readEmail(world, {
      headers: { ...(await presenting(world, fleet, credential)), ...headerFrom(header) },
    })
  },
)

When(
  "an SDK presenting a member key sends an email through {string} with the header {string}",
  async ({ world }, fleet: string, header: string) => {
    await sendEmail(world, fleet, {
      headers: { ...(await presenting(world, fleet, "a member key")), ...headerFrom(header) },
    })
  },
)

const yearOfEmail = async (world: World) => {
  expect(world.last?.status, world.last?.text).toBe(200)
  const reply = await readEmail(world)
  expect(reply.status, reply.text).toBe(200)
  return new Date((reply.body as { created_at: string }).created_at).getUTCFullYear()
}

Then("the email is dated in {int}", async ({ world }, year: number) => {
  expect(await yearOfEmail(world)).toBe(year)
})

Then("the email is not dated in {int}", async ({ world }, year: number) => {
  expect(await yearOfEmail(world)).not.toBe(year)
})

// ---- simultaneous requests -----------------------------------------------------------------

const slowRequests = async (world: World, count: number, fleet: string, delay = "1500ms") => {
  const key = await presenting(world, fleet, "a member key")
  return Array.from({ length: count }, () =>
    sendEmail(world, fleet, { headers: { ...key, "x-mockingbird-delay": delay } }),
  )
}

When(
  "{int} slow requests reach {string} at the same moment",
  async ({ world }, count: number, fleet: string) => {
    const replies = await Promise.all(await slowRequests(world, count, fleet))
    world.things.set("@replies", { list: replies })
  },
)

const replies = (world: World) => world.thing<{ list: Reply[] }>("@replies").list

Then("{int} of them are served", async ({ world }, count: number) => {
  expect(replies(world).filter((reply) => reply.status === 200)).toHaveLength(count)
})

Then(
  "{int} of them are refused as {string} with a time to retry",
  async ({ world }, count: number, code: string) => {
    const refused = replies(world).filter((reply) => reply.status === 429)
    expect(refused).toHaveLength(count)
    for (const reply of refused) {
      expect((reply.body as { error: { code: string } }).error.code).toBe(code)
      expect(Number(reply.headers.get("retry-after"))).toBeGreaterThanOrEqual(1)
    }
  },
)

When(
  "an SDK sends an email through {string} while {int} slow requests occupy {string}",
  async ({ world }, fleet: string, count: number, busy: string) => {
    const slow = Promise.all(await slowRequests(world, count, busy, "4000ms"))
    await sleep(500)
    const reply = sendEmail(world, fleet)
    // The other fleet answers while the busy one is still working through its slow requests.
    const first = await Promise.race([reply.then(() => "the other fleet"), slow.then(() => busy)])
    expect(first).toBe("the other fleet")
    for (const done of await slow) expect(done.status, done.text).toBe(200)
    world.last = await reply
  },
)

// ---- webhooks ------------------------------------------------------------------------------

const receivers = new WeakMap<World, { server: HttpServer; heard: string[]; url: string }>()

Given("a webhook receiver is listening on this machine", async ({ world }) => {
  const heard: string[] = []
  const server = createServer((request, response) => {
    heard.push(`${request.method} ${request.url}`)
    response.end("ok")
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  const port = typeof address === "object" && address ? address.port : 0
  receivers.set(world, { server, heard, url: `http://127.0.0.1:${port}/webhooks` })
})

After({ tags: "@abuse" }, async ({ world }) => {
  const receiver = receivers.get(world)
  if (receiver) await new Promise((resolve) => receiver.server.close(resolve))
})

const receiverOf = (world: World) => {
  const receiver = receivers.get(world)
  if (!receiver) throw new Error("No webhook receiver is listening in this scenario")
  return receiver
}

Given(
  "the {string} emulator of {string} has the receiver registered as a webhook endpoint",
  async ({ world }, emulator: string, fleet: string) => {
    const reply = await world.emulator(
      fleetOf(world, fleet).slug,
      emulator,
      "POST",
      "/v1/webhook_endpoints",
      {
        headers: { ...STRIPE_KEY, "content-type": "application/x-www-form-urlencoded" },
        body: `url=${encodeURIComponent(receiverOf(world).url)}&enabled_events[]=*`,
      },
    )
    expect(reply.status, reply.text).toBe(200)
  },
)

type Delivery = {
  url: string
  state: string
  attempts: { status: number | null; error: string | null }[]
}

Then(
  "the {string} emulator of {string} records the delivery as refused because {string}",
  async ({ world }, emulator: string, fleet: string, reason: string) => {
    const reply = await world.emulator(
      fleetOf(world, fleet).slug,
      emulator,
      "GET",
      "/__admin/webhooks",
      {
        headers: await presenting(world, fleet, "a member key"),
      },
    )
    expect(reply.status, reply.text).toBe(200)
    const deliveries = (reply.body as { deliveries: Delivery[] }).deliveries.filter(
      (delivery) => delivery.url === receiverOf(world).url,
    )
    expect(deliveries.length).toBeGreaterThan(0)
    for (const delivery of deliveries) {
      expect(delivery.state).not.toBe("delivered")
      expect(delivery.attempts.length).toBeGreaterThan(0)
      for (const attempt of delivery.attempts) {
        expect(attempt.status).toBeNull()
        expect(attempt.error).toContain(reason)
      }
    }
  },
)

Then("the receiver has heard nothing", async ({ world }) => {
  expect(receiverOf(world).heard).toEqual([])
})

Then("the customer is still there", async ({ world }) => {
  const customer = world.thing<{ id: string; fleet: string; emulator: string }>("@customer")
  const reply = await world.emulator(
    fleetOf(world, customer.fleet).slug,
    customer.emulator,
    "GET",
    `/v1/customers/${customer.id}`,
    { headers: STRIPE_KEY },
  )
  expect(reply.status, reply.text).toBe(200)
  expect(reply.body).toMatchObject({ id: customer.id })
})

When(
  "{word} allows the {string} emulator of {string} to deliver webhooks to {string}",
  async ({ world }, person: string, emulator: string, fleet: string, origin: string) => {
    await world.api(person, "PATCH", `/fleets/${fleetOf(world, fleet).id}/emulators/${emulator}`, {
      webhookOrigins: [origin],
    })
  },
)

// ---- body size -----------------------------------------------------------------------------

const MIB = 1024 * 1024

When(
  "an SDK sends a {int} MiB body to {string}",
  async ({ world }, size: number, fleetName: string) => {
    const fleet = fleetOf(world, fleetName)
    await announceBody(world, `/f/${fleet.slug}/resend/emails`, size * MIB)
  },
)

When(
  "{word} sends a {int} MiB body to the control API",
  async ({ world }, person: string, size: number) => {
    await world.api(person, "POST", "/orgs", { name: "a".repeat(size * MIB) })
  },
)
