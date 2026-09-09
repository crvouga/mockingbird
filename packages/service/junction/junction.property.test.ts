import { describe, expect, test } from "bun:test"
import { ParityError, parity } from "@crvouga/mockingbird-parity"
import { fcParameters } from "@crvouga/mockingbird-testing"
import { Database } from "@crvouga/sqlite-mem"
import fc from "fast-check"
import { document, JunctionAPI, type JunctionWebhookEvent } from "./src/index.js"

const params = fcParameters(process.env)
const MOCK_HOST = "mock.junction.local"
const AUTH = { "x-vital-api-key": "sk_us_mockingbird" }
const now = () => 1_700_000_000_000

describe("JunctionAPI", () => {
  test(
    "self-parity: independent instances agree on every random walk and conform to the spec",
    async () => {
      const reference = new JunctionAPI({ now })
      const report = await parity({
        provider: "junction",
        spec: document,
        real: {
          baseUrl: `https://${MOCK_HOST}`,
          allowedHosts: [MOCK_HOST],
          headers: () => AUTH,
          fetch: async (request) => {
            await new Promise((resolve) => setTimeout(resolve, 10))
            return reference.fetch(request)
          },
        },
        mock: {
          create: () => new JunctionAPI({ now }),
          baseUrl: `https://${MOCK_HOST}`,
          headers: () => AUTH,
        },
        cleanup: async () => {
          await reference.reset()
        },
        numRuns: params.numRuns ?? 100,
        maxCommands: 30,
        coverageBias: 10,
        latencyToleranceMs: 15,
        ...(params.seed === undefined ? {} : { seed: params.seed }),
        env: process.env,
        sleep: async () => {},
        log: () => {},
      })
      expect(report.walks).toBeGreaterThan(0)
      expect(new Set(Object.keys(report.exercised)).size).toBe(report.planned.length)
    },
    { timeout: 30_000 },
  )

  test("a deliberately divergent instance is caught and shrunk", async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer(), async (seed) => {
        const reference = new JunctionAPI({ now })
        const faulty = () => {
          const api = new JunctionAPI({ now })
          return {
            fetch: async (request: Request) => {
              const response = await api.fetch(request)
              if (request.method !== "POST" || !new URL(request.url).pathname.endsWith("/v2/user"))
                return response
              const body = (await response.json()) as Record<string, unknown>
              return Response.json(
                { ...body, client_user_id: "diverged-client-user" },
                { status: response.status, headers: { "content-type": "application/json" } },
              )
            },
          }
        }
        const failure = await parity({
          provider: "junction",
          spec: document,
          real: {
            baseUrl: `https://${MOCK_HOST}`,
            allowedHosts: [MOCK_HOST],
            headers: () => AUTH,
            fetch: (r) => reference.fetch(r),
          },
          mock: { create: faulty, baseUrl: `https://${MOCK_HOST}`, headers: () => AUTH },
          cleanup: async () => {
            await reference.reset()
          },
          only: ["create_user_v2_user_post"],
          numRuns: 20,
          maxCommands: 6,
          seed,
          invalidProbability: 0,
          sleep: async () => {},
          log: () => {},
        }).then(
          () => undefined,
          (error: unknown) => error,
        )
        expect(failure).toBeInstanceOf(ParityError)
      }),
      { ...params, numRuns: 3 },
    )
  })

  test("captures ordered order webhooks and reset isolates instances", async () => {
    const firstEvents: JunctionWebhookEvent[] = []
    const secondEvents: JunctionWebhookEvent[] = []
    const first = new JunctionAPI({ now, onWebhook: (event) => firstEvents.push(event) })
    const second = new JunctionAPI({ now, onWebhook: (event) => secondEvents.push(event) })
    expect(second).toBeDefined()
    const created = await first.fetch(
      new Request(`https://${MOCK_HOST}/v2/user`, {
        method: "POST",
        headers: { ...AUTH, "content-type": "application/json" },
        body: JSON.stringify({ client_user_id: "webhook-client" }),
      }),
    )
    const { user_id: userId } = (await created.json()) as { user_id: string }
    const order = await first.fetch(
      new Request(`https://${MOCK_HOST}/v3/order`, {
        method: "POST",
        headers: { ...AUTH, "content-type": "application/json" },
        body: JSON.stringify({
          user_id: userId,
          patient_details: {
            first_name: "Ada",
            last_name: "Lovelace",
            dob: "1990-01-01",
            gender: "female",
            phone_number: "+14155551234",
            email: "ada@example.com",
          },
          patient_address: {
            first_line: "1 Main St",
            city: "San Diego",
            state: "CA",
            zip: "92101",
            country: "US",
          },
          order_set: { lab_test_ids: ["c533549c-1e62-4afe-9a0e-0567a9b2bcc2"] },
        }),
      }),
    )
    expect(order.status).toBe(200)
    const { order: createdOrder } = (await order.json()) as { order: { id: string } }
    await first.fetch(
      new Request(`https://${MOCK_HOST}/v3/order/${createdOrder.id}/cancel`, {
        method: "POST",
        headers: AUTH,
      }),
    )
    expect(firstEvents).toHaveLength(2)
    expect(first.webhookEvents()).toEqual(firstEvents)
    expect((firstEvents[0] as { event_type: string }).event_type).toBe("labtest.order.created")
    expect((firstEvents[1] as { event_type: string }).event_type).toBe("labtest.order.updated")
    expect(secondEvents).toEqual([])
    expect(second.webhookEvents()).toEqual([])
    await first.reset()
    expect(first.webhookEvents()).toEqual([])
  })

  test("injected sqlite client is shared and reset is namespaced", async () => {
    await fc.assert(
      fc.asyncProperty(fc.stringMatching(/^[a-z0-9_-]{1,20}$/), async (clientUserId) => {
        const sqlite = new Database()
        const api = new JunctionAPI({ sqlite, now })
        const created = await api.fetch(
          new Request(`https://${MOCK_HOST}/v2/user`, {
            method: "POST",
            headers: { ...AUTH, "content-type": "application/json" },
            body: JSON.stringify({ client_user_id: clientUserId }),
          }),
        )
        expect(created.status).toBe(200)
        const { user_id } = (await created.json()) as { user_id: string }
        await api.reset()
        const gone = await api.fetch(
          new Request(`https://${MOCK_HOST}/v2/user/${user_id}`, { headers: AUTH }),
        )
        expect(gone.status).toBe(404)
      }),
      { ...params, numRuns: 10 },
    )
  })
})
