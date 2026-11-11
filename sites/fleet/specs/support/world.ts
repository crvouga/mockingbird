import { OPERATOR_TOKEN, type Stack } from "./stack.js"

export type Reply = { status: number; headers: Headers; body: unknown; text: string }

export type Credential =
  | { kind: "session"; cookie: string }
  | { kind: "key"; key: string }
  | { kind: "anonymous" }

/**
 * What one scenario knows: the stack it runs against, the people in it, the things they have
 * made (looked up by the name the feature file uses), and the last reply the system gave.
 */
export class World {
  /** Named people and their credentials ("Ada" → her browser session). */
  readonly people = new Map<string, Credential>()
  /** Named resources and values: organizations, projects, fleets, keys, by the feature's name. */
  readonly things = new Map<string, Record<string, unknown>>()
  last: Reply | undefined

  constructor(
    public stack: Stack,
    /** Unique per scenario, so scenarios sharing one server never collide on emails or slugs. */
    readonly tag: string,
  ) {}

  get url(): string {
    return this.stack.url
  }

  /** A stored thing by name; fails with the names that do exist. */
  thing<T = Record<string, unknown>>(name: string): T {
    const found = this.things.get(name)
    if (!found)
      throw new Error(`Nothing named "${name}". Known: ${[...this.things.keys()].join(", ")}`)
    return found as T
  }

  /** The unique email this scenario uses for a person. */
  email(person: string): string {
    return `${person.toLowerCase()}.${this.tag}@example.test`
  }

  /** A slug unique to this scenario, derived from a readable name. */
  slug(name: string): string {
    return `${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${this.tag}`.slice(0, 40)
  }

  /** Sign a person in (dev login on loopback) the first time they are mentioned. */
  async person(name: string, base = this.url): Promise<Credential> {
    const known = this.people.get(name)
    if (known) return known
    const response = await fetch(`${base}/auth/dev-login`, {
      method: "POST",
      headers: { "x-mockingbird-csrf": "1", "content-type": "application/json" },
      body: JSON.stringify({ email: this.email(name) }),
    })
    const cookie = response.headers.get("set-cookie")?.split(";")[0]
    if (!cookie)
      throw new Error(`Could not sign ${name} in: HTTP ${response.status} ${await response.text()}`)
    const credential: Credential = { kind: "session", cookie }
    this.people.set(name, credential)
    return credential
  }

  private headers(credential: Credential): Record<string, string> {
    if (credential.kind === "session")
      return { cookie: credential.cookie, "x-mockingbird-csrf": "1" }
    if (credential.kind === "key") return { authorization: `Bearer ${credential.key}` }
    return {}
  }

  private async reply(response: Response): Promise<Reply> {
    const text = await response.text()
    let body: unknown = text
    try {
      body = JSON.parse(text)
    } catch {}
    this.last = { status: response.status, headers: response.headers, body, text }
    return this.last
  }

  /**
   * Call the control API (`/api/v1` + path) as a named person, with a credential, as the
   * operator, or anonymously. Records and returns the reply.
   */
  async api(
    who: string | Credential | "operator" | "anonymous",
    method: string,
    path: string,
    body?: unknown,
    options: { headers?: Record<string, string>; base?: string } = {},
  ): Promise<Reply> {
    const credential: Credential =
      who === "operator"
        ? { kind: "key", key: OPERATOR_TOKEN }
        : who === "anonymous"
          ? { kind: "anonymous" }
          : typeof who === "string"
            ? await this.person(who, options.base)
            : who
    return this.reply(
      await fetch(`${options.base ?? this.url}/api/v1${path}`, {
        method,
        headers: {
          ...this.headers(credential),
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
          ...options.headers,
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      }),
    )
  }

  /** Like {@link api}, but fails the step unless the call succeeded. Returns the body. */
  async must<T = Record<string, unknown>>(
    who: Parameters<World["api"]>[0],
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const reply = await this.api(who, method, path, body)
    if (reply.status >= 300)
      throw new Error(`${method} ${path} failed: HTTP ${reply.status} ${reply.text}`)
    return reply.body as T
  }

  /**
   * Call an emulator the way a vendor SDK would: `/f/<fleet slug>/<emulator><path>`.
   * No Mockingbird credential is sent unless given in `headers`.
   */
  async emulator(
    fleetSlug: string,
    emulator: string,
    method: string,
    path: string,
    options: { headers?: Record<string, string>; body?: unknown; base?: string } = {},
  ): Promise<Reply> {
    return this.reply(
      await fetch(`${options.base ?? this.url}/f/${fleetSlug}/${emulator}${path}`, {
        method,
        headers: {
          ...(options.body !== undefined ? { "content-type": "application/json" } : {}),
          ...options.headers,
        },
        ...(options.body !== undefined
          ? { body: typeof options.body === "string" ? options.body : JSON.stringify(options.body) }
          : {}),
      }),
    )
  }

  /** The `error.code` of the last reply, or undefined when it was not an error. */
  get errorCode(): string | undefined {
    return (this.last?.body as { error?: { code?: string } } | undefined)?.error?.code
  }
  get errorMessage(): string | undefined {
    return (this.last?.body as { error?: { message?: string } } | undefined)?.error?.message
  }
}
