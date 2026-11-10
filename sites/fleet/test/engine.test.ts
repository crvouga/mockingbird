import { afterEach, expect, test } from "bun:test"
import { type EmulatorRef, type EmulatorSpec, Engine } from "../src/engine.js"
import { memoryObjectStore, type ObjectStore } from "../src/objects.js"
import { createTelemetry } from "../src/telemetry.js"

const telemetry = createTelemetry({ serviceName: "test", write: () => {} })
const engines: Engine[] = []
const engine = (objects: ObjectStore) => {
  const created = new Engine({ objects, telemetry })
  engines.push(created)
  return created
}
afterEach(async () => {
  await Promise.all(engines.splice(0).map((created) => created.close()))
})

const ref = (
  durability: EmulatorSpec["durability"],
  extra: Partial<EmulatorSpec> = {},
): EmulatorRef => ({
  fleetId: "flt_test",
  name: "resend",
  spec: { target: "resend", durability, ...extra },
  baseUrl: "http://localhost/f/demo/resend",
})

const send = async (target: Engine, to: EmulatorRef, subject: string) => {
  const response = await target.handle(
    to,
    new Request("http://localhost/emails", {
      method: "POST",
      headers: { authorization: "Bearer re_test", "content-type": "application/json" },
      body: JSON.stringify({
        from: "a@example.test",
        to: "b@example.test",
        subject,
        html: "<p>hi</p>",
      }),
    }),
  )
  expect(response.status).toBe(200)
  return ((await response.json()) as { id: string }).id
}
const read = (target: Engine, to: EmulatorRef, id: string) =>
  target.handle(
    to,
    new Request(`http://localhost/emails/${id}`, { headers: { authorization: "Bearer re_test" } }),
  )

test("strict: a response is sent only after its state is in object storage", async () => {
  const objects = memoryObjectStore()
  const id = await send(engine(objects), ref("strict"), "first")
  expect(objects.objects.size).toBe(1)
  // A second replica that has never seen the emulator serves the committed write.
  const response = await read(engine(objects), ref("strict"), id)
  expect(response.status).toBe(200)
  expect(((await response.json()) as { subject: string }).subject).toBe("first")
})

test("strict: two replicas writing in turn never lose each other's writes", async () => {
  const objects = memoryObjectStore()
  const left = engine(objects)
  const right = engine(objects)
  const ids: string[] = []
  for (let index = 0; index < 6; index++)
    ids.push(await send(index % 2 ? left : right, ref("strict"), `message ${index}`))
  expect(new Set(ids).size).toBe(6)
  for (const id of ids) expect((await read(left, ref("strict"), id)).status).toBe(200)
})

test("strict: a commit that loses the race re-runs the request on the winner's state", async () => {
  const objects = memoryObjectStore()
  const left = engine(objects)
  const right = engine(objects)
  await send(left, ref("strict"), "seed")
  // Make `right` write between `left`'s read and `left`'s commit, once.
  let raced = false
  const racing: ObjectStore = {
    ...objects,
    async put(key, bytes, expected) {
      if (!raced) {
        raced = true
        await send(right, ref("strict"), "interloper")
      }
      return objects.put(key, bytes, expected)
    },
  }
  const racer = engine(racing)
  const id = await send(racer, ref("strict"), "contended")
  const fresh = engine(objects)
  expect((await read(fresh, ref("strict"), id)).status).toBe(200)
  const list = await fresh.exportState(ref("strict"))
  expect(JSON.stringify(list)).toContain("interloper")
  expect(JSON.stringify(list)).toContain("contended")
})

test("buffered: answers from memory, then writes after the flush interval", async () => {
  const objects = memoryObjectStore()
  const target = ref("buffered", { flushIntervalMs: 20 })
  const first = engine(objects)
  const id = await send(first, target, "buffered")
  expect(objects.objects.size).toBe(0)
  expect(first.status("flt_test", "resend", target.spec).dirty).toBe(true)
  await new Promise((resolve) => setTimeout(resolve, 120))
  expect(objects.objects.size).toBe(1)
  expect(first.status("flt_test", "resend", target.spec).dirty).toBe(false)
  expect((await read(engine(objects), target, id)).status).toBe(200)
})

test("buffered: shutdown saves what the interval has not", async () => {
  const objects = memoryObjectStore()
  const target = ref("buffered", { flushIntervalMs: 60_000 })
  const first = engine(objects)
  const id = await send(first, target, "saved at shutdown")
  await first.close()
  expect((await read(engine(objects), target, id)).status).toBe(200)
})

test("ephemeral: nothing is stored", async () => {
  const objects = memoryObjectStore()
  const first = engine(objects)
  const id = await send(first, ref("ephemeral"), "gone")
  expect((await read(first, ref("ephemeral"), id)).status).toBe(200)
  await first.close()
  expect(objects.objects.size).toBe(0)
  expect((await read(engine(objects), ref("ephemeral"), id)).status).toBe(404)
})

test("switching to ephemeral deletes the stored copy; switching back stores again", async () => {
  const objects = memoryObjectStore()
  const target = engine(objects)
  const id = await send(target, ref("strict"), "kept in memory")
  expect(objects.objects.size).toBe(1)
  expect((await read(target, ref("ephemeral"), id)).status).toBe(200)
  expect(objects.objects.size).toBe(0)
  await target.flush(ref("buffered"))
  expect(objects.objects.size).toBe(1)
  expect((await read(engine(objects), ref("strict"), id)).status).toBe(200)
})

test("reset returns the emulator to its boot state on every replica", async () => {
  const objects = memoryObjectStore()
  const left = engine(objects)
  const right = engine(objects)
  const id = await send(left, ref("strict"), "to be reset")
  expect((await read(right, ref("strict"), id)).status).toBe(200)
  await left.reset("flt_test", "resend")
  expect(objects.objects.size).toBe(0)
  expect((await read(right, ref("strict"), id)).status).toBe(404)
})

test("an emulator that is not in the catalog is refused", async () => {
  const target = engine(memoryObjectStore())
  const bad = { ...ref("strict"), spec: { target: "../../etc", durability: "strict" as const } }
  await expect(target.handle(bad, new Request("http://localhost/"))).rejects.toThrow(/No emulator/)
  await expect(target.checkSettings("postgres", undefined)).rejects.toThrow(/No emulator/)
})

test("every catalog emulator loads as an HTTP emulator that speaks the fleet protocol", async () => {
  const { CATALOG } = await import("../src/generated/catalog.js")
  const { loadTarget } = await import("../src/engine.js")
  const broken: string[] = []
  for (const entry of CATALOG) {
    try {
      const target = await loadTarget(entry.target)
      const runtime = (await target.create(
        {},
        { adminKey: undefined, seed: undefined, onLog: undefined },
      )) as Record<string, unknown>
      for (const method of [
        "fetch",
        "namespaces",
        "fleetSnapshot",
        "fleetRestore",
        "fleetExport",
        "fleetImport",
      ])
        if (typeof runtime[method] !== "function") throw new Error(`no ${method}`)
      ;(runtime.stop as (() => void) | undefined)?.()
    } catch (error) {
      broken.push(`${entry.target}: ${(error as Error).message}`)
    }
  }
  expect(broken).toEqual([])
}, 120_000)
