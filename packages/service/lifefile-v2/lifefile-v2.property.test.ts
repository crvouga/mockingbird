import { describe, expect, test } from "bun:test"
import { ParityError, type ParityOptions, parity } from "@crvouga/mockingbird-parity"
import { fcParameters } from "@crvouga/mockingbird-testing"
import fc from "fast-check"
import { document, LifeFileV2API, supportedOperationIds } from "./src/index.js"
import { orderBody } from "./test/consumer.js"

const params = fcParameters(process.env)
const HOST = "mock.lifefile.local"
const now = () => Date.parse("2026-11-24T22:57:51.000Z")
const settings = { enforceVendorId: false }

const token = async () => {
  const response = await new LifeFileV2API({ now, settings }).fetch(
    new Request(`https://${HOST}/api/v2/auth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "x-vendor-id": "10001" },
      body: "grant_type=client_credentials&client_id=lifefile-client&client_secret=lifefile-secret",
    }),
  )
  return ((await response.json()) as { access_token: string }).access_token
}

const WALKED = supportedOperationIds.filter(
  (id) => id !== "RotateCurrentSecret" && id !== "RevokeCurrentToken",
)

const KEY_OPERATIONS = [
  ["ListOrders", "GET", /^\/api\/v2\/orders$/],
  ["CurrentApiUser", "GET", /^\/api\/v2\/auth\/me$/],
  ["ListLocations", "GET", /^\/api\/v2\/locations$/],
  ["ListStatuses", "GET", /^\/api\/v2\/statuses$/],
] as const

const successes: Record<string, number> = {}

const record = (request: Request, response: Response) => {
  const { pathname } = new URL(request.url)
  const found = KEY_OPERATIONS.find(
    ([, method, path]) => method === request.method && path.test(pathname),
  )
  if (found && response.status < 300) successes[found[0]] = (successes[found[0]] ?? 0) + 1
  return response
}

const selfParity = async (
  options: Partial<ParityOptions> & { create?: () => { fetch: (r: Request) => Promise<Response> } },
) => {
  const auth = { authorization: `Bearer ${await token()}`, "x-vendor-id": "10001" }
  const reference = new LifeFileV2API({ now, settings })
  const { create, ...rest } = options
  return parity({
    provider: "lifefile-v2",
    spec: document,
    real: {
      baseUrl: `https://${HOST}`,
      allowedHosts: [HOST],
      headers: () => auth,
      fetch: async (request) => record(request, await reference.fetch(request)),
    },
    mock: {
      create: create ?? (() => new LifeFileV2API({ now, settings })),
      baseUrl: `https://${HOST}`,
      headers: () => auth,
    },
    cleanup: async () => {
      await reference.reset()
    },
    includeUnsafe: true,
    latencyToleranceMs: 10_000,
    seed: params.seed ?? 20_261_124,
    sleep: async () => {},
    log: () => {},
    ...rest,
  })
}

describe("self-parity", () => {
  test("two independent instances agree across every walked operation, and every reply conforms to the contract", async () => {
    const report = await selfParity({
      only: WALKED,
      numRuns: params.numRuns ?? 30,
      maxCommands: 12,
    })
    expect(Object.keys(report.exercised).sort()).toEqual([...WALKED].sort())
    for (const [id] of KEY_OPERATIONS)
      expect({ id, ok: (successes[id] ?? 0) > 0 }).toEqual({ id, ok: true })
  }, 60_000)

  test("a deliberately divergent create is caught", async () => {
    let observed = 0
    const error = await selfParity({
      only: ["CreateOrder"],
      numRuns: 3,
      maxCommands: 3,
      seed: 1,
      invalidProbability: 0,
      create: () => ({
        fetch: async () => {
          observed++
          return Response.json({ type: "success", message: "Success.", data: { orderId: -1 } })
        },
      }),
    }).then(
      () => undefined,
      (e: unknown) => e,
    )
    expect(observed).toBeGreaterThan(0)
    expect(error).toBeInstanceOf(ParityError)
  }, 60_000)
})

const create = async (api: LifeFileV2API, body: unknown) => {
  const auth = await api.fetch(
    new Request(`https://${HOST}/api/v2/auth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "x-vendor-id": "10001" },
      body: "grant_type=client_credentials&client_id=lifefile-client&client_secret=lifefile-secret",
    }),
  )
  const { access_token } = (await auth.json()) as { access_token: string }
  const response = await api.fetch(
    new Request(`https://${HOST}/api/v2/orders`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${access_token}`,
        "x-vendor-id": "10001",
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    }),
  )
  return {
    status: response.status,
    body: (await response.json()) as { data: Record<string, unknown> | null },
  }
}

describe("field limits (decisions over inputs)", () => {
  const LIMITS = [
    ["patient", "lastName", 30, "last name"],
    ["patient", "firstName", 30, "first name"],
    ["prescriber", "lastName", 30, "last name"],
    ["shipping", "addressLine1", 60, "address line1"],
    ["shipping", "city", 100, "city"],
    ["general", "memo", 120, "memo"],
  ] as const

  test("a value longer than its limit is a 422 keyed by that field; at the limit it is accepted", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...LIMITS),
        fc.integer({ min: -3, max: 3 }),
        async ([section, field, limit, words], delta) => {
          const length = Math.max(1, limit + delta)
          const body = orderBody({ uuid: crypto.randomUUID() }) as unknown as {
            order: Record<string, Record<string, unknown>>
          }
          ;(body.order[section] as Record<string, unknown>)[field] = "x".repeat(length)
          const reply = await create(new LifeFileV2API({ now }), body)
          if (length > limit) {
            expect(reply.status).toBe(422)
            expect(reply.body.data).toEqual({
              [`order.${section}.${field}`]: [
                `The order.${section}.${words} may not be greater than ${limit} characters.`,
              ],
            })
          } else {
            expect(reply.status).toBe(200)
          }
        },
      ),
      { ...params, numRuns: params.numRuns ?? 40 },
    )
  }, 60_000)

  test("rx uuid uniqueness ignores case, across any number of lines", async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 4 }), fc.boolean(), async (lines, duplicate) => {
        const base = orderBody().order.rxs[0] as Record<string, unknown>
        const uuids: string[] = Array.from({ length: lines }, () => crypto.randomUUID())
        if (duplicate && lines > 1) uuids[lines - 1] = (uuids[0] as string).toUpperCase()
        const body = orderBody({ rxs: uuids.map((uuid) => ({ ...base, uuid })) })
        const reply = await create(new LifeFileV2API({ now }), body)
        if (duplicate && lines > 1) {
          expect(reply.status).toBe(422)
          expect(Object.keys(reply.body.data ?? {}).sort()).toEqual([
            `order.rxs.0.uuid`,
            `order.rxs.${lines - 1}.uuid`,
          ])
        } else expect(reply.status).toBe(200)
      }),
      { ...params, numRuns: params.numRuns ?? 30 },
    )
  }, 60_000)
})
