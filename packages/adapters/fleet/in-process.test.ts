import { describe, expect, test } from "bun:test"
import { createRuntime } from "@crvouga/mockingbird-service-twilio"
import { createFleet } from "./src/in-process.js"

const request = () => new Request("http://mock/__admin/health")
const config = () => ({
  services: {
    twilio: {
      version: "test-v1",
      create: () =>
        createRuntime({ adminControls: { clock: { frozen: true, now: 2000000000000 } } }),
    },
  },
})
describe("in-process fleet", () => {
  test("creates lazily once, isolates factory failure, and reports unknown service", async () => {
    let calls = 0
    const fleet = createFleet({
      services: {
        twilio: {
          version: "test-v1",
          create: async () => {
            calls++
            return createRuntime()
          },
        },
        broken: {
          version: "test-v1",
          create: () => {
            throw new Error("fixture failure")
          },
        },
      },
    })
    expect(fleet.status().twilio?.status).toBe("idle")
    await Promise.all(
      [1, 2].map(async () => {
        const r = await fleet.fetch("twilio", request())
        expect(r.status).toBe(200)
        await r.text()
      }),
    )
    expect(calls).toBe(1)
    expect(fleet.status().broken?.status).toBe("idle")
    expect((await fleet.fetch("broken", request())).status).toBe(503)
    expect(fleet.status().broken?.status).toBe("failed")
    expect((await fleet.fetch("missing", request())).status).toBe(404)
  })
  test("round-trips runtime portable state and validates compatibility before mutation", async () => {
    const fleet = createFleet(config())
    const response = await fleet.fetch(
      "twilio",
      new Request("http://mock/__admin/state/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: "fixture", value: { fixture: true } }),
      }),
    )
    expect(response.ok).toBe(true)
    await response.text()
    const archive = await fleet.export()
    const restored = createFleet(config())
    await restored.import(archive)
    expect(await restored.export()).toEqual(archive)
    const bad = structuredClone(archive)
    if (bad.services.twilio) bad.services.twilio.version = "other"
    await expect(restored.import(bad)).rejects.toThrow("compatibility mismatch: twilio")
    expect(await restored.export()).toEqual(archive)
  })
  test("idle archives do not construct services, and failed codecs do not mutate existing state", async () => {
    const fleet = createFleet(config())
    const archive = await fleet.export()
    expect(archive.services.twilio?.state).toBeNull()
    await fleet.import(archive)
    expect(fleet.status().twilio?.status).toBe("idle")
    const bad = structuredClone(archive)
    if (bad.services.twilio) bad.services.twilio.state = { default: { corrupt: true } }
    await expect(fleet.import(bad)).rejects.toThrow()
  })
  test("archive waits for streamed work and admits later requests only after capture", async () => {
    let finish!: () => void
    const base = createRuntime()
    const fleet = createFleet({
      services: {
        stream: {
          version: "test-v1",
          create: () => ({
            ...base,
            fetch: async () =>
              new Response(
                new ReadableStream({
                  start(controller) {
                    finish = () => controller.close()
                  },
                }),
              ),
          }),
        },
      },
    })
    const response = await fleet.fetch("stream", request())
    let captured = false
    const saving = fleet.export().then(() => {
      captured = true
    })
    await Promise.resolve()
    expect(captured).toBe(false)
    finish()
    await response.text()
    await saving
    expect(captured).toBe(true)
  })
  test("unimplemented controls fail explicitly without starting services", async () => {
    const fleet = createFleet(config())
    const response = await fleet.control(
      new Request("http://fleet/__admin/fleet/dashboard", { method: "POST", body: "{}" }),
    )
    expect(response.status).toBe(501)
    expect(fleet.status().twilio?.status).toBe("idle")
  })
})

const control = (
  fleet: ReturnType<typeof createFleet>,
  path: string,
  body?: unknown,
  method = body === undefined ? "GET" : "POST",
) =>
  fleet.control(
    new Request(`http://fleet/__admin/fleet${path}`, {
      method,
      headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  )

test("namespace controls use native clock and snapshot stores", async () => {
  const fleet = createFleet(config())
  expect((await control(fleet, "/namespaces/tenant", {})).status).toBe(201)
  expect(await (await control(fleet, "/namespaces")).json()).toEqual({
    namespaces: ["tenant"],
  })
  expect(
    (await control(fleet, "/clock?namespace=tenant", { set: 2000000000000, freeze: true })).status,
  ).toBe(200)
  const point = await (
    await control(fleet, "/namespaces/tenant/snapshots", { label: "fixture" })
  ).json()
  expect(point.id).toBe("fixture")
  const clock = await (await control(fleet, "/clock?namespace=tenant")).json()
  expect((await control(fleet, "/clock?namespace=tenant", { advance: 1000 })).ok).toBe(true)
  expect((await control(fleet, "/namespaces/tenant/snapshots/fixture/restore", {})).ok).toBe(true)
  expect(await (await control(fleet, "/clock?namespace=tenant")).json()).toEqual(clock)
  const snapshots = await (await control(fleet, "/namespaces/tenant/snapshots")).json()
  expect(snapshots.services.twilio[0].id).toBe("fixture")
  expect((await control(fleet, "/namespaces/tenant/reset", { services: ["twilio"] })).ok).toBe(true)
  expect(
    (await (await control(fleet, "/namespaces/tenant/snapshots")).json()).services.twilio,
  ).toEqual([])
})

test("invalid selection and failed archive decoding preserve boot status", async () => {
  const fleet = createFleet(config())
  expect((await control(fleet, "/clock", { services: ["missing"], advance: 10 })).status).toBe(400)
  expect(fleet.status().twilio?.status).toBe("idle")
  const bad = await fleet.export()
  if (bad.services.twilio) bad.services.twilio.state = { default: { corrupt: true } }
  await expect(fleet.import(bad)).rejects.toThrow()
  expect(fleet.status().twilio?.status).toBe("idle")
})

test("late restore failure leaves existing and idle runtimes untouched", async () => {
  let fail = false
  const options = {
    services: {
      first: {
        version: "v1",
        create: () =>
          createRuntime({ adminControls: { clock: { frozen: true, now: 2000000000000 } } }),
      },
      second: {
        version: "v1",
        create: () => {
          const runtime = createRuntime({
            adminControls: { clock: { frozen: true, now: 2000000000000 } },
          })
          return {
            ...runtime,
            fleetRestore: (point: object, namespace: string) => {
              if (fail) throw new Error("fixture restore failure")
              runtime.fleetRestore(point, namespace)
            },
          }
        },
      },
    },
  }
  const source = createFleet(options)
  for (const service of ["first", "second"])
    await (await source.fetch(service, new Request("http://mock/__admin/state/messages"))).text()
  const archive = await source.export()
  const target = createFleet(options)
  await (await target.fetch("first", request())).text()
  const before = await target.export()
  fail = true
  await expect(target.import(archive)).rejects.toThrow("fixture restore failure")
  expect(await target.export()).toEqual(before)
  expect(target.status().second?.status).toBe("idle")
})

test("staging failure and successful swaps dispose only runtimes they retire", async () => {
  let disposed = 0
  const fleet = createFleet({
    services: {
      twilio: {
        ...config().services.twilio,
        dispose: () => {
          disposed++
        },
      },
    },
  })
  await (await fleet.fetch("twilio", new Request("http://mock/__admin/state/messages"))).text()
  const archive = await fleet.export()
  const bad = structuredClone(archive)
  if (bad.services.twilio) bad.services.twilio.state = { default: { corrupt: true } }
  await expect(fleet.import(bad)).rejects.toThrow()
  expect(disposed).toBe(1)
  expect(await fleet.export()).toEqual(archive)
  expect(await fleet.import(archive)).toEqual({ committed: true, cleanupErrors: {} })
  expect(disposed).toBe(2)
})
