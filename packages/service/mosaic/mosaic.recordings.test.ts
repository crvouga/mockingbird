import { expect, test } from "bun:test"
import { readdirSync } from "node:fs"
import { createRuntime } from "./src/index.js"
import { isRecord } from "./src/wire.js"
import { consumer, orderBody } from "./test/consumer.js"

const fixtures = new URL("./test/fixtures/", import.meta.url)
const readFixture = async (name: string): Promise<{ status: number; body: unknown }> =>
  Bun.file(new URL(name, fixtures)).json()

const replay = (fixture: keyof typeof requests) => {
  const { fetch } = createRuntime({ adminControls: { clock: { now: "2025-07-01", frozen: true } } })
  const client = consumer(fetch)
  const place = async () => {
    const patientId = await client.id(await client.createPatient())
    return client.id(await client.createOrder(orderBody(patientId)))
  }
  const complete = async () => {
    const orderId = await place()
    const path = `/__admin/lines/${orderId}/263/transition`
    expect((await client.request(path, "POST", { statusId: 2 })).status).toBe(200)
    expect((await client.request(path, "POST", { statusId: 1 })).status).toBe(200)
    return orderId
  }
  const lines = (orderId: number) => client.lines({ OrderIdFrom: orderId, OrderIdTo: orderId })
  const cancel = async (orderId: number) => (await client.cancel(orderId, [263], 3)).response
  const cancelled = async () => {
    const orderId = await place()
    expect((await cancel(orderId)).status).toBe(200)
    return orderId
  }
  return requests[fixture]({ client, fetch, place, complete, lines, cancel, cancelled })
}

type ReplayContext = {
  client: ReturnType<typeof consumer>
  fetch: Parameters<typeof consumer>[0]
  place: () => Promise<number>
  complete: () => Promise<number>
  lines: (id: number) => Promise<Response>
  cancel: (id: number) => Promise<Response>
  cancelled: () => Promise<number>
}

const requests = {
  "error.invalid-patient-create.json": ({ client }) => client.createPatient({}),
  "error.missing-lines.json": ({ client }) => client.lines({ OrderIdFrom: 0, OrderIdTo: 0 }),
  "error.missing-order.json": ({ client }) => client.getOrder(0),
  "error.missing-patient.json": ({ client }) => client.getPatient(0),
  "error.missing-pdf.json": ({ client }) => client.pdf("missing.pdf"),
  "error.no-key.json": ({ fetch }) => consumer(fetch, undefined, {}).testTypes(),
  "order.cancel-again.json": async ({ cancel, cancelled }) => cancel(await cancelled()),
  "order.cancel.json": async ({ cancel, place }) => cancel(await place()),
  "order.create.json": async ({ client }) =>
    client.createOrder(orderBody(await client.id(await client.createPatient()))),
  "patient.create.json": ({ client }) => client.createPatient(),
  "patient.get.json": async ({ client }) =>
    client.getPatient(await client.id(await client.createPatient())),
  "patientresults.list.json": async ({ client, complete }) => client.listResults(await complete()),
  "salesorder.completed.json": async ({ client, complete }) => client.getOrder(await complete()),
  "salesorder.placed.json": async ({ client, place }) => client.getOrder(await place()),
  "salesorderlines.cancelled.json": async ({ lines, cancelled }) => lines(await cancelled()),
  "salesorderlines.completed.json": async ({ lines, complete }) => lines(await complete()),
  "salesorderlines.placed.json": async ({ lines, place }) => lines(await place()),
} satisfies Record<string, (context: ReplayContext) => Promise<Response>>

const wireShape = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(wireShape)
  if (isRecord(value))
    return Object.fromEntries(
      Object.entries(value).map(([key, member]) => [key, wireShape(member)]),
    )
  return value === null ? "null" : typeof value
}

const files = readdirSync(fixtures)
  .filter((name) => name.endsWith(".json"))
  .sort()
test("every recording has a replay request", () => {
  expect(files).toEqual(Object.keys(requests).sort())
})

for (const name of Object.keys(requests) as (keyof typeof requests)[]) {
  test(`recording replay matches status and wire shape for ${name}`, async () => {
    const fixture = await readFixture(name)
    const response = await replay(name)
    expect(response.status).toBe(fixture.status)
    const contentType = response.headers.get("content-type")
    if (isRecord(fixture.body) && typeof fixture.body._nonJson === "string") {
      expect(contentType).toStartWith("text/plain")
      expect(await response.text()).toBe(fixture.body._nonJson)
      return
    }
    expect(contentType).toStartWith(
      fixture.status >= 400 ? "application/problem+json" : "application/json",
    )
    // The capture saved only data for these three samples. The empty-line capture kept the wire page.
    let body = fixture.body
    if (Array.isArray(body)) {
      const emptyPage = (await readFixture("error.missing-lines.json")).body
      if (!isRecord(emptyPage)) throw new Error("expected a recorded flat page")
      body = { ...emptyPage, data: body }
    }
    expect(wireShape(await response.json())).toEqual(wireShape(body))
  })
}
