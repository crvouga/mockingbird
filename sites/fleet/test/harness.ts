import { createApp } from "../src/app.js"
import { createAuth } from "../src/auth.js"
import { type Config, loadConfig } from "../src/config.js"
import { Engine } from "../src/engine.js"
import { UsageMeter } from "../src/limits.js"
import { memoryObjectStore } from "../src/objects.js"
import { memoryDatabase } from "../src/store/memory.js"
import type { Database } from "../src/store/schema.js"
import { createTelemetry } from "../src/telemetry.js"

export const ORIGIN = "http://localhost:8080"

export type Client = {
  /** Call the control API. Returns the parsed body and status. */
  api<T = Record<string, unknown>>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; body: T }>
  raw(method: string, path: string, init?: RequestInit): Promise<Response>
}

export function harness(
  options: {
    db?: Database
    config?: Partial<Config>
    fetch?: typeof fetch
    now?: () => number
  } = {},
) {
  const db = options.db ?? memoryDatabase()
  const objects = memoryObjectStore()
  const telemetry = createTelemetry({ serviceName: "test", write: () => {} })
  const engine = new Engine({ objects, telemetry })
  const now = options.now ?? Date.now
  const meter = new UsageMeter(db, now, 3_600_000)
  // The defaults a loopback server boots with, plus whatever the test overrides.
  const config = { ...loadConfig({ AUTH_DEV_LOGIN: "1", PORT: "8080" }), ...options.config }
  const app = createApp({
    db,
    engine,
    auth: createAuth({ db, config, ...(options.fetch ? { fetch: options.fetch } : {}) }),
    config,
    telemetry,
    meter,
    now,
    asset: (path) =>
      path === "/index.html"
        ? new Response("<!doctype html><title>Fleet</title>", {
            headers: { "content-type": "text/html" },
          })
        : undefined,
  })

  const client = (credentials: { cookie?: string; key?: string } = {}): Client => {
    const raw = (method: string, path: string, init: RequestInit = {}) =>
      app.fetch(
        new Request(`${ORIGIN}${path}`, {
          method,
          ...init,
          headers: {
            ...(credentials.cookie
              ? { cookie: credentials.cookie, "x-mockingbird-csrf": "1" }
              : {}),
            ...(credentials.key ? { authorization: `Bearer ${credentials.key}` } : {}),
            ...(init.headers as Record<string, string> | undefined),
          },
        }),
      )
    return {
      raw,
      async api(method, path, body) {
        const response = await raw(method, `/api/v1${path}`, {
          ...(body !== undefined
            ? { body: JSON.stringify(body), headers: { "content-type": "application/json" } }
            : {}),
        })
        return { status: response.status, body: (await response.json()) as never }
      },
    }
  }

  /** Sign in on loopback as `email` and return a client holding that session. */
  const signIn = async (email: string) => {
    const response = await client().raw("POST", "/auth/dev-login", {
      body: JSON.stringify({ email }),
      headers: { "x-mockingbird-csrf": "1" },
    })
    const cookie = response.headers.get("set-cookie")?.split(";")[0]
    if (!cookie) throw new Error(`dev login failed: ${response.status}`)
    return client({ cookie })
  }

  return {
    app,
    db,
    objects,
    engine,
    meter,
    config,
    client,
    signIn,
    close: async () => {
      await engine.close()
      await meter.close()
    },
  }
}
