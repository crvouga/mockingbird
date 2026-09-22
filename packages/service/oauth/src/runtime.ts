import {
  type Clock,
  type FaultPreset,
  type ServiceRuntime,
  createRuntime as serviceRuntime,
} from "@crvouga/mockingbird-service"
import type { SqliteClient } from "@crvouga/mockingbird-sqlite"
import { OAUTH_SCENARIOS } from "./behavior.js"
import { document } from "./generated/openapi.js"
import { OAuthAPI, type OAuthAPIOptions } from "./index.js"
import type { Account, Client } from "./types.js"
export const OAUTH_PRESETS: Record<string, FaultPreset> = {
  token_unavailable: {
    description: "Token endpoint returns temporarily_unavailable",
    rules: ["Token", "AppleToken", "MicrosoftToken", "GitHubToken"].map((operationId) => ({
      operationId,
      status: 503,
      body: { error: "temporarily_unavailable" },
    })),
  },
  access_denied: {
    description: "Authorization is denied before interaction",
    rules: [
      "Authorize",
      "GoogleAuthorize",
      "GoogleLegacyAuthorize",
      "AppleAuthorize",
      "MicrosoftAuthorize",
      "GitHubAuthorize",
    ].map((operationId) => ({ operationId, status: 403, body: { error: "access_denied" } })),
  },
}
export type OAuthRuntimeOptions = Omit<OAuthAPIOptions, "namespace" | "now" | "publicNamespace"> & {
  clock?: Clock
  adminKey?: string
  seed?: number | string
  sqlite?: SqliteClient
}
export type OAuthRuntime = ServiceRuntime<OAuthAPI>
export function createRuntime(options: OAuthRuntimeOptions = {}): OAuthRuntime {
  return serviceRuntime({
    name: "oauth",
    document,
    presets: OAUTH_PRESETS,
    ...(options.sqlite ? { sqlite: options.sqlite } : {}),
    ...(options.clock ? { clock: options.clock } : {}),
    ...(options.adminKey !== undefined ? { adminKey: options.adminKey } : {}),
    ...(options.seed !== undefined ? { seed: options.seed } : {}),
    create: ({ sqlite, namespace, publicNamespace, clock }) =>
      new OAuthAPI({ ...options, sqlite, namespace, publicNamespace, now: clock.now }),
    admin: (runtime) => ({
      "GET /scenarios": () => Response.json(OAUTH_SCENARIOS),
      "GET /behavior": ({ namespace }) =>
        Response.json({
          behavior: runtime.instance(namespace).behavior.config,
          events: runtime.instance(namespace).behavior.events,
        }),
      "PUT /behavior": ({ namespace, body }) => {
        try {
          return Response.json(runtime.instance(namespace).behavior.configure(body))
        } catch (error) {
          return Response.json({ error: String(error) }, { status: 400 })
        }
      },
      "POST /consents/revoke": ({ namespace, body }) => {
        const input = body as { clientId?: unknown; accountId?: unknown } | null
        if (!input || typeof input.clientId !== "string" || typeof input.accountId !== "string")
          return Response.json({ error: "clientId and accountId are required" }, { status: 400 })
        runtime.instance(namespace).revokeConsent(input.clientId, input.accountId)
        return Response.json({ revoked: true })
      },
      "POST /keys/rotate": ({ namespace, body }) => {
        const input = body as { retainPrevious?: unknown } | null
        if (input?.retainPrevious !== undefined && typeof input.retainPrevious !== "boolean")
          return Response.json({ error: "retainPrevious must be boolean" }, { status: 400 })
        return Response.json(
          runtime.instance(namespace).rotateSigningKey(input?.retainPrevious !== false),
        )
      },
      "GET /accounts": ({ namespace }) =>
        Response.json({
          accounts: runtime
            .instance(namespace)
            .accounts.list({ order: "oldest" })
            .map((a) => a.value),
        }),
      "POST /accounts": ({ namespace, body }) => {
        try {
          return Response.json(runtime.instance(namespace).seedAccount(body as Account), {
            status: 201,
          })
        } catch (error) {
          return Response.json({ error: String(error) }, { status: 400 })
        }
      },
      "GET /clients": ({ namespace }) =>
        Response.json({
          clients: runtime
            .instance(namespace)
            .clients.list({ order: "oldest" })
            .map(({ value }) => ({
              id: value.id,
              name: value.name,
              redirectUris: value.redirectUris,
              requirePkce: value.requirePkce ?? value.secret === undefined,
            })),
        }),
      "POST /clients": ({ namespace, body }) => {
        try {
          const client = runtime.instance(namespace).registerClient(body as Client)
          return Response.json(
            { id: client.id, name: client.name, redirectUris: client.redirectUris },
            { status: 201 },
          )
        } catch (error) {
          return Response.json({ error: String(error) }, { status: 400 })
        }
      },
    }),
  })
}
