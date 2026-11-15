import { expect, test } from "bun:test"
import { Collection, createRuntime, createWebhookHub, signers } from "@crvouga/mockingbird-service"
import { createFleet } from "./src/in-process.js"

const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

test("awaited webhook reentry drains before exclusive capture without deadlock", async () => {
  const entered = deferred(),
    proceed = deferred()
  let deliver!: (request: Request) => Promise<Response>
  let captured = false
  const fleet = createFleet({
    controlTimeoutMs: 1000,
    fetch: ((input: RequestInfo | URL, init?: RequestInit) =>
      deliver(new Request(input, init))) as typeof fetch,
    services: {
      fixture: {
        version: "test",
        create: ({ fetch }) => {
          const hub = createWebhookHub({
            signer: signers.none(),
            retryDelaysMs: [0],
            endpoints: [{ url: "http://app/webhook" }],
            fetch: (request) => fetch(request),
          })
          return createRuntime({
            name: "fixture",
            create: (context) => {
              const rows = new Collection<{ value: string }>(
                context.sqlite,
                context.namespace,
                "rows",
              )
              return {
                fetch: async (request) => {
                  if (new URL(request.url).pathname === "/start") {
                    rows.insert("outer", { value: "outer" })
                    entered.resolve()
                    await proceed.promise
                    hub.publish({
                      namespace: context.namespace,
                      type: "changed",
                      body: { changed: true },
                    })
                    await hub.flush()
                    expect(hub.deliveries(context.namespace)[0]?.state).toBe("delivered")
                  } else rows.insert("nested", { value: "nested" })
                  return Response.json(rows.list().map((row) => row.value))
                },
                reset: async () => {
                  for (const row of rows.list()) rows.delete(row.id)
                },
              }
            },
          })
        },
      },
    },
  })
  deliver = (request) => fleet.fetch("fixture", request)
  const outer = fleet.fetch("fixture", new Request("http://fixture/start"))
  await entered.promise
  const snapshot = fleet.export().then((value) => {
    captured = true
    return value
  })
  await Promise.resolve()
  expect(captured).toBe(false)
  proceed.resolve()
  expect(await (await outer).json()).toHaveLength(2)
  const saved = await snapshot
  const restored = createFleet({
    services: {
      fixture: {
        version: "test",
        create: () =>
          createRuntime({
            name: "fixture",
            create: (context) => {
              const rows = new Collection<{ value: string }>(
                context.sqlite,
                context.namespace,
                "rows",
              )
              return {
                fetch: async () => Response.json(rows.list().map((row) => row.value)),
                reset: async () => {},
              }
            },
          }),
      },
    },
  })
  await restored.import(saved)
  expect(
    await (await restored.fetch("fixture", new Request("http://fixture/rows"))).json(),
  ).toEqual([{ value: "nested" }, { value: "outer" }])
  await fleet.dispose()
  await restored.dispose()
})

test("an acquired exclusive capture queues application mutation", async () => {
  let mutate!: () => Promise<void>
  let duringCapture = false,
    mutationDuringCapture = false,
    scheduled = false
  let mutation: Promise<void> | undefined
  const base = createRuntime({
    name: "fixture",
    create: (context) => {
      const rows = new Collection<{ value: string }>(context.sqlite, context.namespace, "rows")
      return {
        fetch: async (request) => {
          if (request.method === "POST") {
            mutationDuringCapture ||= duringCapture
            rows.insert("new", { value: "new" })
          }
          return Response.json(rows.list())
        },
        reset: async () => {},
      }
    },
  })
  const fleet = createFleet({
    services: {
      fixture: {
        version: "test",
        create: () => ({
          ...base,
          fleetSnapshot(namespace) {
            duringCapture = true
            if (!scheduled) {
              scheduled = true
              mutation = mutate()
            }
            const point = base.fleetSnapshot(namespace)
            queueMicrotask(() => {
              duringCapture = false
            })
            return point
          },
        }),
      },
    },
  })
  await (await fleet.fetch("fixture", new Request("http://fixture/rows"))).text()
  mutate = async () => {
    await (
      await fleet.fetch("fixture", new Request("http://fixture/rows", { method: "POST" }))
    ).text()
  }
  const captured = await fleet.export()
  await mutation
  expect(mutationDuringCapture).toBe(false)
  expect(
    await (await fleet.fetch("fixture", new Request("http://fixture/rows"))).json(),
  ).toHaveLength(1)
  await fleet.import(captured)
  expect(await (await fleet.fetch("fixture", new Request("http://fixture/rows"))).json()).toEqual(
    [],
  )
  await fleet.dispose()
})

test("writer starvation times out explicitly without poisoning later controls", async () => {
  const base = createRuntime({
    name: "fixture",
    create: () => ({
      fetch: async () => new Response(new ReadableStream()),
      reset: async () => {},
    }),
  })
  const fleet = createFleet({
    controlTimeoutMs: 20,
    services: { fixture: { version: "test", create: () => base } },
  })
  const response = await fleet.fetch("fixture", new Request("http://fixture/rows"))
  await expect(fleet.export()).rejects.toThrow("waiting for active requests to drain")
  expect(
    (
      await fleet.control(
        new Request("http://fleet/__admin/fleet/archives/export", { method: "POST", body: "{}" }),
      )
    ).status,
  ).toBe(409)
  await response.body?.cancel()
  expect((await fleet.export()).format).toBe("mockingbird.in-process/v1")
  await fleet.dispose()
})
