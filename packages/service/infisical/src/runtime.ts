import {
  type AdminRoutes,
  bearerToken,
  type Clock,
  createRuntime as createServiceRuntime,
  type FaultPreset,
  type MockControls,
  type RequestLog,
  type ServiceRuntime,
} from "@crvouga/mockingbird-service"
import { document } from "./generated/openapi.js"
import { InfisicalAPI, type InfisicalAPIOptions, object } from "./index.js"
import { DEFAULT_ADMIN_KEY, type Grant, normalizePath, type ProjectTree } from "./state.js"
import { createVaultKey } from "./vault.js"
export const INFISICAL_PRESETS: Record<string, FaultPreset> = {
  rate_limited: {
    description: "Reject one request with a synthetic vendor 429 and Retry-After",
    rules: [
      {
        status: 429,
        headers: { "Retry-After": "1" },
        body: {
          reqId: "fixture-request",
          statusCode: 429,
          message: "Rate limit exceeded",
          error: "RateLimitError",
        },
      },
    ],
  },
  missing_version: {
    description: "Make the next secret lookup behave like a missing version",
    rules: [{ operationId: "GetSecret", effect: "missing_version" }],
  },
  server_error: {
    description: "Reject a request with a synthetic vendor 500",
    rules: [
      {
        status: 500,
        body: {
          reqId: "fixture-request",
          statusCode: 500,
          message: "Something went wrong",
          error: "InternalServerError",
        },
      },
    ],
  },
  network_reset: { description: "Drop a request before any write", rules: [{ drop: true }] },
}
export type InfisicalRuntimeOptions = Omit<
  InfisicalAPIOptions,
  "now" | "namespace" | "vaultNamespace"
> & {
  clock?: Clock
  seed?: number | string
  adminPrefix?: string
  adminKey?: string
  /** Admin controls to boot with: clock, latency, faults, seed, a starting snapshot. */
  adminControls?: MockControls
  onLog?: (entry: RequestLog) => void
}
export type InfisicalRuntime = ServiceRuntime<InfisicalAPI>
const adminError = (status: number, message: string): Response =>
  Response.json({ error: { type: "mockingbird_admin", message } }, { status })
const routes = (runtime: InfisicalRuntime): AdminRoutes => ({
  "GET /project-tree": ({ namespace }) => {
    const api = runtime.instance(namespace)
    return Response.json({
      organizations: api.state.organizations.list().map((r) => r.value),
      projects: api.state.projects.list().map((r) => r.value),
      environments: api.state.environments.list().map((r) => r.value),
      folders: api.state.folders.list().map((r) => r.value),
      secrets: api.state.secrets.list().map((r) => api.metadata(r.value)),
    })
  },
  "POST /project-tree": ({ namespace, body }) => {
    try {
      return Response.json(runtime.instance(namespace).seedTree(body as ProjectTree), {
        status: 201,
      })
    } catch {
      return adminError(400, "Invalid project tree")
    }
  },
  "GET /secrets": ({ namespace }) =>
    Response.json({
      secrets: runtime
        .instance(namespace)
        .state.secrets.list()
        .map((r) => runtime.instance(namespace).metadata(r.value)),
    }),
  "POST /secrets/rotate": ({ namespace, body }) => {
    const data = object(body)
    if (
      typeof data.secretValue !== "string" ||
      typeof data.secretName !== "string" ||
      typeof data.projectId !== "string" ||
      typeof data.environment !== "string"
    )
      return adminError(400, "projectId, environment, secretName and secretValue are required")
    const api = runtime.instance(namespace)
    let path: string
    try {
      path = normalizePath(typeof data.secretPath === "string" ? data.secretPath : "/")
    } catch {
      return adminError(400, "Invalid secret path")
    }
    const secret = api.state.find(data.projectId, data.environment, path, data.secretName)
    if (!secret) return adminError(404, "Unknown secret")
    const clear = api.state.data(secret)
    clear.value = data.secretValue
    const { sealed: _sealed, ...metadata } = secret
    const rotated = api.state.save(
      {
        ...metadata,
        version: secret.version + 1,
        updatedAt: new Date(runtime.namespaceClock(namespace).now()).toISOString(),
      },
      clear,
    )
    return Response.json({ secret: api.metadata(rotated) })
  },
  "GET /tokens": ({ namespace }) =>
    Response.json({
      tokens: runtime
        .instance(namespace)
        .state.tokens.list()
        .map(({ value }) => {
          const { credential: _credential, ...metadata } = value
          return metadata
        }),
    }),
  "POST /tokens/:id/expire": ({ namespace, params }) => {
    const api = runtime.instance(namespace)
    const token = api.state.tokens.get(params.id ?? "")
    if (!token) return adminError(404, "Unknown token")
    api.state.tokens.update(token.id, {
      ...token,
      expiresAt: runtime.namespaceClock(namespace).now(),
    })
    return Response.json({ id: token.id, expired: true })
  },
  "POST /tokens/:id/revoke": ({ namespace, params }) => {
    const api = runtime.instance(namespace)
    const token = api.state.tokens.get(params.id ?? "")
    if (!token) return adminError(404, "Unknown token")
    api.state.tokens.update(token.id, { ...token, revoked: true })
    return Response.json({ id: token.id, revoked: true })
  },
  "POST /machines/:id/revoke": ({ namespace, params }) => {
    const api = runtime.instance(namespace)
    if (!api.state.machines.has(params.id ?? "")) return adminError(404, "Unknown machine")
    let count = 0
    for (const { value: t } of api.state.tokens.list()) {
      if (t.machineId !== params.id) continue
      api.state.tokens.update(t.id, { ...t, revoked: true })
      count++
    }
    return Response.json({ revoked: count })
  },
  "POST /permissions/deny": ({ namespace, body }) => {
    const data = object(body)
    if (
      typeof data.projectId !== "string" ||
      typeof data.environment !== "string" ||
      typeof data.path !== "string"
    )
      return adminError(400, "projectId, environment and path are required")
    let path: string
    try {
      path = normalizePath(data.path)
    } catch {
      return adminError(400, "Invalid secret path")
    }
    const api = runtime.instance(namespace)
    const id = api.state.ids.next("denial_", 24)
    const grant: Grant = {
      projectId: data.projectId,
      environment: data.environment,
      path,
      recursive: data.recursive === true,
    }
    api.state.denials.insert(id, grant)
    return Response.json({ id, ...grant }, { status: 201 })
  },
})
export const createRuntime = (options: InfisicalRuntimeOptions = {}): InfisicalRuntime => {
  const adminKey = options.adminKey ?? DEFAULT_ADMIN_KEY
  if (!adminKey) throw new Error("Infisical adminKey must not be empty")
  const vaultKey = options.vaultKey ?? createVaultKey()
  return createServiceRuntime({
    name: "infisical",
    document,
    ...(options.sqlite ? { sqlite: options.sqlite } : {}),
    ...(options.clock ? { clock: options.clock } : {}),
    ...(options.seed !== undefined ? { seed: options.seed } : {}),
    ...(options.adminPrefix !== undefined ? { adminPrefix: options.adminPrefix } : {}),
    adminKey,
    ...(options.adminControls !== undefined ? { adminControls: options.adminControls } : {}),
    ...(options.onLog ? { onLog: options.onLog } : {}),
    create: ({ sqlite, namespace, publicNamespace, clock }) =>
      new InfisicalAPI({
        ...options,
        sqlite,
        namespace,
        now: clock.now,
        vaultKey,
        vaultNamespace: publicNamespace,
      }),
    credential: bearerToken,
    presets: INFISICAL_PRESETS,
    admin: routes,
  })
}
