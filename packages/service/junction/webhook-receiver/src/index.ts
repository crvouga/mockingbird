export type WebhookEvent = {
  payload: unknown
  received_at: string
}

type StoredEvent = WebhookEvent & {
  sequence: number
}

export type Environment = {
  WEBHOOK_EVENTS: DurableObjectNamespace
}

const JSON_HEADERS = { "content-type": "application/json" }
const MAX_BODY_BYTES = 1_048_576
const MAX_EVENTS = 1_000

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: JSON_HEADERS })

const runIdFromRequest = (request: Request) => {
  const runId =
    request.headers.get("x-mockingbird-scope") ?? new URL(request.url).searchParams.get("run_id")
  return runId?.trim() || undefined
}

const durableObjectId = (namespace: DurableObjectNamespace, runId: string) =>
  namespace.idFromName(runId)

export class WebhookEvents {
  constructor(private readonly state: DurableObjectState) {}

  async fetch(request: Request) {
    const url = new URL(request.url)
    if (request.method === "POST" && url.pathname === "/events") return this.append(request)
    if (request.method === "GET" && url.pathname === "/events") return this.list()
    if (request.method === "DELETE" && url.pathname === "/events") return this.clear()
    return json(404, { error: "not_found" })
  }

  private async append(request: Request) {
    const contentLength = Number(request.headers.get("content-length") ?? 0)
    if (contentLength > MAX_BODY_BYTES) return json(413, { error: "payload_too_large" })
    const body = await request.text()
    if (new TextEncoder().encode(body).byteLength > MAX_BODY_BYTES)
      return json(413, { error: "payload_too_large" })
    let payload: unknown
    try {
      payload = JSON.parse(body) as unknown
    } catch {
      return json(400, { error: "invalid_json" })
    }
    const current = (await this.state.storage.get<StoredEvent[]>("events")) ?? []
    const next: StoredEvent = {
      sequence: (current.at(-1)?.sequence ?? 0) + 1,
      payload,
      received_at: new Date().toISOString(),
    }
    await this.state.storage.put("events", [...current, next].slice(-MAX_EVENTS))
    return json(202, { accepted: true, sequence: next.sequence })
  }

  private async list() {
    const events = (await this.state.storage.get<StoredEvent[]>("events")) ?? []
    return json(200, events)
  }

  private async clear() {
    await this.state.storage.delete("events")
    return new Response(null, { status: 204 })
  }
}

export default {
  async fetch(request: Request, environment: Environment) {
    const url = new URL(request.url)
    if (request.method === "GET" && url.pathname === "/health") return json(200, { status: "ok" })
    if (request.method === "GET" && url.pathname.startsWith("/events/")) {
      const runId = decodeURIComponent(url.pathname.slice("/events/".length)).trim()
      if (!runId) return json(400, { error: "missing_run_id" })
      const id = durableObjectId(environment.WEBHOOK_EVENTS, runId)
      return environment.WEBHOOK_EVENTS.get(id).fetch(new Request("https://webhook-events/events"))
    }
    if (request.method === "DELETE" && url.pathname.startsWith("/events/")) {
      const runId = decodeURIComponent(url.pathname.slice("/events/".length)).trim()
      if (!runId) return json(400, { error: "missing_run_id" })
      const id = durableObjectId(environment.WEBHOOK_EVENTS, runId)
      return environment.WEBHOOK_EVENTS.get(id).fetch(
        new Request("https://webhook-events/events", request),
      )
    }
    if (request.method !== "POST" || url.pathname !== "/junction/webhooks")
      return json(404, { error: "not_found" })
    const runId = runIdFromRequest(request)
    if (!runId) return json(400, { error: "missing_run_id" })
    const id = durableObjectId(environment.WEBHOOK_EVENTS, runId)
    const stub = environment.WEBHOOK_EVENTS.get(id)
    return stub.fetch(new Request("https://webhook-events/events", request))
  },
} satisfies ExportedHandler<Environment>

export const eventsEndpoint = (baseUrl: string, runId: string) =>
  `${baseUrl.replace(/\/$/, "")}/events/${encodeURIComponent(runId)}`
