import { replaceKnownIds } from "@crvouga/mockingbird-canonicalize"
import type { ResourceTable, Side } from "@crvouga/mockingbird-model"
import {
  createWebhookCollector,
  type WebhookRow,
  type WebhookStore,
} from "@crvouga/mockingbird-webhook-collector"

type JsonObject = Record<string, unknown>
const record = (value: unknown): JsonObject | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined

const STABLE_FIELDS = [
  "active",
  "amount",
  "amount_received",
  "currency",
  "customer",
  "description",
  "email",
  "livemode",
  "metadata",
  "name",
  "payment_intent",
  "price",
  "product",
  "status",
  "subscription",
] as const

/** Stripe generates event IDs and delivery times independently on each side. */
export const stripeEventSignature = (value: unknown, table: ResourceTable, side: Side) => {
  const event = record(value)
  const data = record(event?.data)
  const object = record(data?.object)
  if (!event || typeof event.type !== "string" || !object) return { invalid: true }
  const objectType = typeof object.object === "string" ? object.object : "unknown"
  const objectId = typeof object.id === "string" ? object.id : undefined
  const knownId = objectId
    ? table.knownIds(side).find(({ id }) => id === objectId)?.resource
    : undefined
  const fields: JsonObject = {}
  for (const field of STABLE_FIELDS) {
    const fieldValue = object[field]
    if (fieldValue !== undefined) {
      fields[field] = JSON.parse(
        replaceKnownIds(JSON.stringify(fieldValue), table, side),
      ) as unknown
    }
  }
  return {
    type: event.type,
    object: objectType,
    id: knownId ? `resource:${knownId.type}:${knownId.handle}` : `${objectType}:unbound`,
    fields,
    previousKeys: Object.keys(record(data?.previous_attributes) ?? {}).sort(),
  }
}

export const compareStripeWebhooks = (
  real: readonly unknown[],
  mock: readonly unknown[],
  table: ResourceTable,
): string | undefined => {
  if (
    [...real, ...mock].some((value) => {
      const event = record(value)
      return typeof event?.type !== "string" || !record(record(event.data)?.object)
    })
  )
    return "invalid Stripe webhook payload"
  const signatures = (events: readonly unknown[], side: Side) =>
    events.map((event) => JSON.stringify(stripeEventSignature(event, table, side))).sort()
  const realSignatures = signatures(real, "real")
  const mockSignatures = signatures(mock, "mock")
  if (JSON.stringify(realSignatures) === JSON.stringify(mockSignatures)) return undefined
  if (real.length !== mock.length) return `event count real=${real.length} mock=${mock.length}`
  const index = realSignatures.findIndex((signature, i) => signature !== mockSignatures[i])
  return `event signature differs at sorted index ${index}: real=${realSignatures[index]} mock=${mockSignatures[index]}`
}

type StripeOracle = {
  cursor(): number
  collect(cursor: number, expected: number): Promise<unknown[]>
  close(): Promise<void>
}

/** Stripe CLI owns the websocket connection; its HTTP forwarder feeds the shared Hono receiver. */
export const startStripeWebhookOracle = async (apiKey: string): Promise<StripeOracle> => {
  const rows: WebhookRow[] = []
  const store: WebhookStore = {
    async insert(row) {
      rows.push(row)
    },
    async list({ service, runId }) {
      return rows.filter(
        (row) =>
          (service === undefined || row.service === service) &&
          (runId === undefined || row.run_id === runId),
      )
    },
  }
  const app = createWebhookCollector(store)
  const receiver = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: app.fetch,
  })
  const cli = Bun.spawn(
    [
      "stripe",
      "listen",
      "--skip-update",
      "--forward-to",
      `http://127.0.0.1:${receiver.port}/stripe`,
    ],
    {
      env: { ...process.env, STRIPE_API_KEY: apiKey },
      stdout: "pipe",
      stderr: "pipe",
    },
  )
  let ready = false
  let exitCode: number | undefined
  let readyResolve: (() => void) | undefined
  let readyReject: ((error: Error) => void) | undefined
  const readyPromise = new Promise<void>((resolve, reject) => {
    readyResolve = resolve
    readyReject = reject
  })
  const drain = async (stream: ReadableStream<Uint8Array>) => {
    const reader = stream.getReader()
    const decoder = new TextDecoder()
    let tail = ""
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        // Do not log CLI output: its ready line contains the webhook signing secret.
        const chunk = tail + decoder.decode(value, { stream: true })
        tail = chunk.slice(-16)
        if (chunk.includes("Ready!")) {
          ready = true
          readyResolve?.()
        }
      }
    } finally {
      reader.releaseLock()
    }
  }
  const stdout = drain(cli.stdout)
  const stderr = drain(cli.stderr)
  void cli.exited.then((code) => {
    exitCode = code
    if (!ready) readyReject?.(new Error(`stripe listen exited before ready (status ${code})`))
  })
  let readyTimer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      readyPromise,
      new Promise<never>((_, reject) => {
        readyTimer = setTimeout(
          () => reject(new Error("stripe listen did not become ready within 30 seconds")),
          30_000,
        )
      }),
    ])
  } catch (error) {
    cli.kill()
    receiver.stop(true)
    throw error
  } finally {
    clearTimeout(readyTimer)
  }
  return {
    cursor: () => rows.length,
    async collect(cursor, expected) {
      const deadline = Date.now() + 10_000
      let previousCount = -1
      let stableSince = Date.now()
      const uniqueEvents = () => {
        const seen = new Set<string>()
        return rows.slice(cursor).flatMap((row) => {
          const payload = record(row.payload)
          const id = typeof payload?.id === "string" ? payload.id : undefined
          if (id !== undefined) {
            if (seen.has(id)) return []
            seen.add(id)
          }
          return [row.payload]
        })
      }
      do {
        if (exitCode !== undefined)
          throw new Error(`stripe listen exited during parity (status ${exitCode})`)
        const count = uniqueEvents().length
        if (count !== previousCount) {
          previousCount = count
          stableSince = Date.now()
        }
        if (count >= expected && Date.now() - stableSince >= 500) return uniqueEvents()
        await Bun.sleep(100)
      } while (Date.now() < deadline)
      return uniqueEvents()
    },
    async close() {
      cli.kill()
      receiver.stop(true)
      await cli.exited
      await Promise.allSettled([stdout, stderr])
    },
  }
}
