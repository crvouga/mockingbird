import type { FetchAPI } from "@crvouga/mockingbird-core"
import {
  SUPER_ADMIN_CLIENT_ID,
  SUPER_ADMIN_CLIENT_SECRET,
  SUPER_ADMIN_EMAIL,
  SUPER_ADMIN_PASSWORD,
} from "./config.js"
import { type MedplumProcessOptions, MedplumServerProcess } from "./process.js"

export type { MedplumServerConfig } from "./config.js"
export { buildServerConfig, SUPER_ADMIN_EMAIL, SUPER_ADMIN_PASSWORD } from "./config.js"
export type { MedplumPaths } from "./paths.js"
export { resolveMedplumPaths } from "./paths.js"
export type { MedplumProcessInfo, MedplumProcessOptions } from "./process.js"

const AUTH_LOGIN_PATH = "/auth/login"
const OAUTH_TOKEN_PATH = "/oauth2/token"

export type MedplumAPIOptions = MedplumProcessOptions & {
  /** Username for the seeded super admin. Defaults match Medplum's dev seed. */
  email?: string | undefined
  /** Password for the seeded super admin. */
  password?: string | undefined
}

type TokenResponse = {
  access_token?: string
  token_type?: string
  expires_in?: number
}

/**
 * Stateful Medplum mock backed by the real Medplum server, self-hosted as a
 * child process on embedded Postgres and Redis. Implements the Mockingbird
 * FetchAPI contract by proxying every request to the running server, with
 * explicit async lifecycle calls following the adapter convention.
 */
export class MedplumAPI implements FetchAPI {
  private readonly process: MedplumServerProcess
  private readonly options: MedplumAPIOptions
  private cachedToken: string | undefined

  constructor(options: MedplumAPIOptions = {}) {
    const { email, password, ...processOptions } = options
    this.options = { email, password, ...processOptions }
    this.process = new MedplumServerProcess(processOptions)
  }

  fetch(request: Request): Promise<Response> {
    const target = this.rewriteUrl(request.url)
    const headers = new Headers(request.headers)
    headers.delete("host")
    headers.delete("connection")
    headers.delete("content-length")
    const init: RequestInit = {
      method: request.method,
      headers,
      redirect: "manual",
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      init.body = request.body
    }
    return fetch(new Request(target, init))
  }

  /** Boot embedded Postgres + Redis, ensure the server build, and start the server. */
  async start(): Promise<void> {
    await this.process.start()
  }

  /** Stop the server and tear down Postgres, Redis, and the temp dir. */
  async stop(): Promise<void> {
    this.cachedToken = undefined
    await this.process.stop()
  }

  /** Drop every resource (truncate all tables) and restart the server. */
  async reset(): Promise<void> {
    this.cachedToken = undefined
    await this.process.reset()
  }

  get isStarted(): boolean {
    return this.process.isStarted
  }

  /** Ephemeral port of the running API server. */
  get apiPort(): number {
    return this.process.apiPort
  }

  /** Base URL of the running server (internal ephemeral port). */
  getBaseUrl(): string {
    return this.process.baseUrl
  }

  /**
   * OAuth2 password + PKCE login for the seeded super admin, returning a
   * bearer token for API calls. The token is cached until reset()/stop().
   */
  async getAccessToken(): Promise<string> {
    if (this.cachedToken) return this.cachedToken
    const base = this.process.baseUrl.replace(/\/+$/, "")
    const email = this.options.email ?? SUPER_ADMIN_EMAIL
    const password = this.options.password ?? SUPER_ADMIN_PASSWORD

    const loginResponse = await fetch(`${base}${AUTH_LOGIN_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email,
        password,
        clientId: SUPER_ADMIN_CLIENT_ID,
        scope: "openid offline",
        codeChallenge: SUPER_ADMIN_CLIENT_SECRET,
        codeChallengeMethod: "plain",
      }),
    })
    if (!loginResponse.ok) {
      throw new Error(
        `medplum login failed (${loginResponse.status}): ${await loginResponse.text()}`,
      )
    }
    const login = (await loginResponse.json()) as { code?: string; membership?: unknown }
    if (!login.code) throw new Error("medplum login did not return a login code")

    const tokenResponse = await fetch(`${base}${OAUTH_TOKEN_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: login.code,
        client_id: SUPER_ADMIN_CLIENT_ID,
        code_verifier: SUPER_ADMIN_CLIENT_SECRET,
      }),
    })
    if (!tokenResponse.ok) {
      throw new Error(
        `medplum token exchange failed (${tokenResponse.status}): ${await tokenResponse.text()}`,
      )
    }
    const token = ((await tokenResponse.json()) as TokenResponse).access_token
    if (!token) throw new Error("medplum token exchange did not return an access token")
    this.cachedToken = token
    return token
  }

  private rewriteUrl(rawUrl: string): string {
    const base = this.process.baseUrl.replace(/\/+$/, "")
    const incoming = new URL(rawUrl)
    const internal = new URL(base)
    internal.pathname = incoming.pathname
    internal.search = incoming.search
    return internal.toString()
  }
}

/** Async factory that boots the server before returning, pairing with the parity runner's async `mock.create`. */
export const createMedplumAPI = async (options: MedplumAPIOptions = {}): Promise<MedplumAPI> => {
  const api = new MedplumAPI(options)
  await api.start()
  return api
}
