import { expect, test } from "bun:test"
import { createRuntime, DroppedConnectionError } from "./src/index.js"

const request = (path: string, method = "GET", body?: unknown, namespace = "default") =>
  new Request(`http://mock${path}`, {
    method,
    headers: { "content-type": "application/json", "x-mockingbird-namespace": namespace },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })

test("forwarding is opt-in, namespace-scoped, journaled, resettable and streams", async () => {
  const sent: Request[] = []
  const runtime = createRuntime({
    name: "fixture",
    create: () => ({ fetch: async () => new Response("emulated"), reset: async () => {} }),
    upstream: {
      baseUrl: "https://vendor.example/base",
      fetch: (req) => {
        sent.push(req)
        return new Response("upstream", { status: 201, headers: { "x-vendor": "yes" } })
      },
      rewriteAuth: (req) => {
        req.headers.set("authorization", "fixture-upstream")
        return req
      },
    },
  })
  expect(await (await runtime.fetch(request("/send"))).text()).toBe("emulated")
  expect(sent).toHaveLength(0)
  expect(
    (await runtime.fetch(request("/__admin/upstream", "PUT", { mode: "forward" }))).status,
  ).toBe(200)
  const result = await runtime.fetch(request("/send?q=1", "POST", { text: "fixture" }))
  expect(result.status).toBe(201)
  expect(result.headers.get("x-vendor")).toBe("yes")
  expect(await result.text()).toBe("upstream")
  expect(sent[0]?.url).toBe("https://vendor.example/base/send?q=1")
  expect(sent[0]?.headers.get("authorization")).toBe("fixture-upstream")
  expect(sent[0]?.headers.has("x-mockingbird-namespace")).toBe(false)
  expect(await sent[0]?.json()).toEqual({ text: "fixture" })
  expect(await (await runtime.fetch(request("/send", "GET", undefined, "other"))).text()).toBe(
    "emulated",
  )
  const logs = await (await runtime.fetch(request("/__admin/requests"))).json()
  expect(JSON.stringify(logs)).toContain('"upstream":true')
  expect(JSON.stringify(logs)).not.toContain("fixture-upstream")
  const snapshot = runtime.snapshots.create()
  const document = runtime.snapshots.export(snapshot.id)
  expect(document.upstream?.mode).toBe("forward")
  expect(JSON.stringify(document)).not.toContain("fixture-upstream")
  await runtime.fetch(request("/__admin/upstream", "PUT", { mode: "emulated" }))
  runtime.snapshots.restore(snapshot.id)
  expect((await (await runtime.fetch(request("/__admin/upstream"))).json()).mode).toBe("forward")
  await runtime.reset()
  expect(await (await runtime.fetch(request("/send"))).text()).toBe("emulated")
})

test("missing transport rejects the switch and transport failures use network-drop errors", async () => {
  const create = () => ({ fetch: async () => new Response("emulated"), reset: async () => {} })
  const absent = createRuntime({ name: "fixture", create })
  expect(
    (await absent.fetch(request("/__admin/upstream", "PUT", { mode: "forward" }))).status,
  ).toBe(409)
  const failing = createRuntime({
    name: "fixture",
    create,
    upstream: {
      baseUrl: "https://vendor.example",
      mode: "forward",
      fetch: () => {
        throw new Error("fixture failure")
      },
    },
  })
  await expect(failing.fetch(request("/send"))).rejects.toBeInstanceOf(DroppedConnectionError)
})

test("faults preempt upstream IO and streamed response does not await body completion", async () => {
  let called = 0
  let output!: ReadableStreamDefaultController<Uint8Array>
  const runtime = createRuntime({
    name: "fixture",
    create: () => ({ fetch: async () => new Response(), reset: async () => {} }),
    upstream: {
      baseUrl: "https://vendor.example",
      mode: "forward",
      fetch: () => {
        called++
        return new Response(
          new ReadableStream<Uint8Array>({
            start(c) {
              output = c
            },
          }),
        )
      },
    },
  })
  await runtime.fetch(request("/__admin/faults", "POST", { status: 503, count: 1 }))
  expect((await runtime.fetch(request("/send"))).status).toBe(503)
  expect(called).toBe(0)
  const response = await runtime.fetch(request("/send"))
  expect(called).toBe(1)
  const reader = response.body?.getReader()
  output.enqueue(new TextEncoder().encode("first"))
  expect(new TextDecoder().decode((await reader?.read())?.value)).toBe("first")
  output.close()
  expect((await reader?.read())?.done).toBe(true)
})

test("upstream override validates and respects the admin key without persisting", async () => {
  let calls = 0
  const runtime = createRuntime({
    name: "fixture",
    adminKey: "fixture-admin-key",
    create: () => ({ fetch: async () => new Response("emulated"), reset: async () => {} }),
    upstream: {
      baseUrl: "https://vendor.example",
      mode: "forward",
      fetch: () => {
        calls++
        return new Response("forward")
      },
    },
  })
  const send = (mode: string, key?: string) =>
    runtime.fetch(
      new Request("http://mock/send", {
        headers: {
          "x-mockingbird-upstream": mode,
          ...(key ? { "x-mockingbird-admin-key": key } : {}),
        },
      }),
    )
  expect((await send("emulated")).status).toBe(401)
  expect((await send("typo", "fixture-admin-key")).status).toBe(400)
  expect(await (await send("emulated", "fixture-admin-key")).text()).toBe("emulated")
  expect(calls).toBe(0)
  expect(await (await runtime.fetch(request("/send"))).text()).toBe("forward")
  expect(calls).toBe(1)
  expect(() =>
    runtime.snapshots.import({
      format: "mockingbird.snapshot/v1",
      records: [],
      upstream: { mode: "forward", baseUrl: "https://user:password@vendor.example" },
    }),
  ).toThrow()
})
