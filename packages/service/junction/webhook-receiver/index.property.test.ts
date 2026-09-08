import { describe, expect, test } from "bun:test"
import fc from "fast-check"
import worker, { type Environment, eventsEndpoint } from "./src/index.js"

type StoredValue = unknown

class MemoryStorage implements DurableObjectStorage {
  private readonly values = new Map<string, StoredValue>()

  delete(key: string) {
    this.values.delete(key)
    return Promise.resolve(true)
  }

  get<T>(key: string) {
    return Promise.resolve(this.values.get(key) as T | undefined)
  }

  put<T>(key: string, value: T) {
    this.values.set(key, value)
    return Promise.resolve()
  }
}

class MemoryState implements DurableObjectState {
  readonly storage = new MemoryStorage()
  id = {} as DurableObjectId
  waitUntil() {}
  blockConcurrencyWhile<T>(callback: () => Promise<T>) {
    return callback()
  }
}

class MemoryNamespace implements DurableObjectNamespace {
  readonly state = new MemoryState()
  idFromName(name: string) {
    return { name } as unknown as DurableObjectId
  }
  get() {
    return {
      fetch: (request: Request) => new Response("", { status: 501, headers: request.headers }),
    } as unknown as DurableObjectStub
  }
}

describe("Junction webhook receiver", () => {
  test("builds isolated event endpoints", () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 20 }),
        fc.string({ minLength: 1, maxLength: 20 }),
        (base, runId) => {
          const endpoint = eventsEndpoint(`https://receiver.workers.dev/${base}/`, runId)
          expect(endpoint).toContain(`/events/${encodeURIComponent(runId)}`)
        },
      ),
    )
  })

  test("requires the parity run scope", async () => {
    await fc.assert(
      fc.asyncProperty(fc.constant(undefined), async () => {
        const environment = { WEBHOOK_EVENTS: new MemoryNamespace() } as unknown as Environment
        const response = await worker.fetch(
          new Request("https://receiver.workers.dev/junction/webhooks", {
            method: "POST",
            body: JSON.stringify({ event_type: "labtest.order.created" }),
          }),
          environment,
        )
        expect(response.status).toBe(400)
        expect(await response.json()).toEqual({ error: "missing_run_id" })
      }),
    )
  })

  test("exposes a health check", async () => {
    await fc.assert(
      fc.asyncProperty(fc.constant(undefined), async () => {
        const environment = { WEBHOOK_EVENTS: new MemoryNamespace() } as unknown as Environment
        const response = await worker.fetch(
          new Request("https://receiver.workers.dev/health"),
          environment,
        )
        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({ status: "ok" })
      }),
    )
  })
})
