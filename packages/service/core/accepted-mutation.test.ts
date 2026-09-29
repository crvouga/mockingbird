import { expect, test } from "bun:test"
import {
  Collection,
  createRuntime,
  DroppedConnectionError,
  markMutationAccepted,
} from "./src/index.js"

test("an accepted mutation remains in the current checkpoint when reply delivery fails", async () => {
  const runtime = createRuntime({
    name: "accepted-test",
    create: ({ sqlite, namespace }) => {
      const records = new Collection<{ value: number }>(sqlite, namespace, "items")
      return {
        records,
        reset: async () => {},
        fetch: async (request: Request) => {
          records.insert("accepted", { value: 1 })
          markMutationAccepted(request, { ids: { itemId: "accepted" } })
          throw new DroppedConnectionError()
        },
      }
    },
  })
  await expect(
    runtime.fetch(new Request("http://test.local/items", { method: "POST" })),
  ).rejects.toThrow()
  expect(runtime.instance().records.get("accepted")).toEqual({ value: 1 })
  const head = runtime.timeline().head("main")
  expect(head).toBeDefined()
  if (!head) throw new Error("Missing checkpoint")
  runtime.checkout(head.id)
  expect(runtime.instance().records.get("accepted")).toEqual({ value: 1 })
  expect(runtime.journal.list()).toMatchObject([{ status: 0 }])
})

for (const behavior of [
  "unmarked-error",
  "accepted-error",
  "accepted-success",
  "rejected",
] as const) {
  test(`acceptance is opt-in and idempotent: ${behavior}`, async () => {
    const runtime = createRuntime({
      name: "acceptance-control",
      create: ({ sqlite, namespace }) => {
        const records = new Collection<{ value: number }>(sqlite, namespace, "items")
        return {
          records,
          reset: async () => {},
          fetch: async (request: Request) => {
            if (behavior === "rejected") return new Response(null, { status: 409 })
            records.insert("item", { value: 1 })
            if (behavior !== "unmarked-error") {
              markMutationAccepted(request, { ids: { itemId: "item" } })
              markMutationAccepted(request)
            }
            if (behavior !== "accepted-success") throw new Error("delivery failed")
            return new Response(null, { status: 201 })
          },
        }
      },
    })
    const before = runtime.checkpoint()
    const result = await runtime
      .fetch(new Request("http://test.local/items", { method: "POST" }))
      .then(
        (response) => response,
        (error) => error,
      )
    const accepted = behavior.startsWith("accepted")
    const head = runtime.timeline().head("main")
    if (!head) throw new Error("Missing checkpoint")
    expect(head.id === before.id).toBe(!accepted)
    const logs = runtime.journal.list()
    expect(logs).toHaveLength(1)
    expect(logs[0]?.accepted).toBe(accepted ? true : undefined)
    if (accepted) expect(logs[0]?.checkpoint).toBe(head.id)
    if (behavior === "accepted-success")
      expect(result.headers.get("x-mockingbird-checkpoint")).toBe(head.id)
    runtime.checkout(head.id)
    expect(runtime.instance().records.get("item")).toEqual(accepted ? { value: 1 } : undefined)
  })
}
