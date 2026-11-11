import {
  type Channel,
  filterToSearch,
  type Notification,
  type NotificationFilter,
  type SourceStatus,
} from "./model.js"

export type NotificationClientOptions = {
  /** Default namespace for every call that does not name one. */
  namespace?: string
  fetch?: (request: Request) => Response | Promise<Response>
}

/** Talks to a running harness over HTTP, for tests that run in another process. */
export class NotificationClient {
  readonly baseUrl: string
  private readonly namespace: string | undefined
  private readonly fetchImpl: (request: Request) => Response | Promise<Response>

  constructor(baseUrl: string, options: NotificationClientOptions = {}) {
    this.baseUrl = baseUrl.replace(/\/+$/, "")
    this.namespace = options.namespace
    this.fetchImpl = options.fetch ?? ((request) => fetch(request))
  }

  private async get<T>(
    path: string,
    filter: NotificationFilter = {},
    extra: Record<string, string> = {},
  ) {
    const params = filterToSearch({ namespace: this.namespace, ...filter })
    for (const [k, v] of Object.entries(extra)) params.set(k, v)
    const query = params.toString()
    const response = await this.fetchImpl(
      new Request(`${this.baseUrl}${path}${query ? `?${query}` : ""}`),
    )
    const body = (await response.json()) as T & { error?: { message?: string } }
    if (!response.ok) {
      const error = new Error(body.error?.message ?? `HTTP ${response.status}`)
      Object.assign(error, { status: response.status, body })
      throw error
    }
    return body
  }

  /** Every matching notification, oldest first. */
  async list(filter: NotificationFilter = {}): Promise<Notification[]> {
    return (await this.get<{ notifications: Notification[] }>("/api/notifications", filter))
      .notifications
  }

  /** The newest match, or `null`. */
  async latest(filter: NotificationFilter = {}): Promise<Notification | null> {
    try {
      return await this.get<Notification>("/api/notifications/latest", filter)
    } catch (error) {
      if ((error as { status?: number }).status === 404) return null
      throw error
    }
  }

  /** Wait until `count` (default 1) notifications match and return them; throws on timeout. */
  async waitFor(
    filter: NotificationFilter,
    options: { timeoutMs?: number; count?: number } = {},
  ): Promise<Notification[]> {
    const extra: Record<string, string> = {}
    if (options.timeoutMs !== undefined) extra.timeoutMs = String(options.timeoutMs)
    if (options.count !== undefined) extra.count = String(options.count)
    return (await this.get<{ notifications: Notification[] }>("/api/wait", filter, extra))
      .notifications
  }

  /** Wait for the next SMS to `to` and return its one-time code (Twilio Verify) or first 4–8 digit run. */
  async waitForCode(
    to: string,
    filter: NotificationFilter = {},
    timeoutMs?: number,
  ): Promise<string> {
    const found = await this.waitFor(
      { channel: "sms", to, ...filter },
      timeoutMs === undefined ? {} : { timeoutMs },
    )
    const last = found.at(-1)
    const code = last?.sms?.code ?? /\b(\d{4,8})\b/.exec(last?.sms?.body ?? "")?.[1]
    if (!code) throw new Error(`no code in the latest SMS to ${to}`)
    return code
  }

  async sources(): Promise<SourceStatus[]> {
    return (await this.get<{ sources: SourceStatus[] }>("/api/sources")).sources
  }

  /** A UI link that opens one device (or one notification) for a screenshot. */
  link(view: { channel?: Channel; to?: string; id?: string } = {}): string {
    const params = new URLSearchParams()
    if (this.namespace) params.set("namespace", this.namespace)
    if (view.channel) params.set("view", view.channel)
    if (view.to) params.set("to", view.to)
    if (view.id) params.set("id", view.id)
    const query = params.toString()
    return `${this.baseUrl}/${query ? `?${query}` : ""}`
  }
}
