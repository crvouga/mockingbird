export type FetchLike = (request: Request) => Promise<Response>

export type OpenBaoClientOptions = {
  /** Base address such as `https://vault.chrisvouga.dev`. */
  address: string
  fetch?: FetchLike
  /** Optional namespace forwarded as `X-Vault-Namespace`. */
  namespace?: string
}

export class OpenBaoError extends Error {
  constructor(
    readonly status: number,
    readonly errors: readonly string[],
    readonly operation: string,
  ) {
    super(`OpenBao ${operation} failed with HTTP ${status}: ${errors.join("; ") || "no detail"}`)
    this.name = "OpenBaoError"
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const errorsOf = (body: unknown) =>
  isRecord(body) && Array.isArray(body.errors)
    ? body.errors.filter((item): item is string => typeof item === "string")
    : []

const trimSlashes = (text: string) => text.replace(/^\/+|\/+$/g, "")

/** Minimal OpenBao HTTP client: JWT login and KV v2 reads. Never logs or stores anything. */
export class OpenBaoClient {
  private readonly address: string
  private readonly fetchImpl: FetchLike
  private readonly namespace: string | undefined

  constructor(options: OpenBaoClientOptions) {
    const url = new URL(options.address)
    if (url.protocol !== "https:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1")
      throw new RangeError(`OpenBao address must use https: ${url.origin}`)
    this.address = url.origin
    this.fetchImpl = options.fetch ?? ((request) => fetch(request))
    this.namespace = options.namespace
  }

  private async request(
    operation: string,
    method: "GET" | "POST",
    path: string,
    token: string | undefined,
    body?: unknown,
  ): Promise<unknown> {
    const headers = new Headers({ accept: "application/json" })
    if (token !== undefined) headers.set("x-vault-token", token)
    if (this.namespace !== undefined) headers.set("x-vault-namespace", this.namespace)
    if (body !== undefined) headers.set("content-type", "application/json")
    const response = await this.fetchImpl(
      new Request(`${this.address}/v1/${trimSlashes(path)}`, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    )
    const text = await response.text()
    let parsed: unknown
    if (text !== "") {
      try {
        parsed = JSON.parse(text)
      } catch {
        parsed = undefined
      }
    }
    if (!response.ok) throw new OpenBaoError(response.status, errorsOf(parsed), operation)
    return parsed
  }

  /** Exchange a JWT (for example a GitHub OIDC token) for a short-lived client token. */
  async loginWithJwt(options: { jwt: string; role: string; mount?: string }) {
    const mount = trimSlashes(options.mount ?? "jwt")
    const body = await this.request("jwt login", "POST", `auth/${mount}/login`, undefined, {
      jwt: options.jwt,
      role: options.role,
    })
    const auth = isRecord(body) && isRecord(body.auth) ? body.auth : undefined
    const token = auth?.client_token
    if (typeof token !== "string" || token === "")
      throw new OpenBaoError(200, ["login response carried no client_token"], "jwt login")
    const ttl = typeof auth?.lease_duration === "number" ? auth.lease_duration : undefined
    return { token, ...(ttl === undefined ? {} : { leaseDurationSeconds: ttl }) }
  }

  /** Read the `data` of a KV v2 secret. `path` is the full API path, e.g. `secret/data/foo`. */
  async readKv2(token: string, path: string): Promise<Record<string, string>> {
    const body = await this.request("read secret", "GET", path, token)
    const data = isRecord(body) && isRecord(body.data) ? body.data : undefined
    const inner = data && isRecord(data.data) ? data.data : data
    if (!inner) throw new OpenBaoError(200, [`secret at ${path} has no data`], "read secret")
    const out: Record<string, string> = {}
    for (const [key, value] of Object.entries(inner)) {
      if (typeof value === "string") out[key] = value
    }
    return out
  }

  /** Revoke the calling token so nothing outlives the run. Best effort. */
  async revokeSelf(token: string) {
    try {
      await this.request("revoke token", "POST", "auth/token/revoke-self", token)
    } catch {
      return
    }
  }
}
