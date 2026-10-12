import {
  type AdminRoutes,
  type Clock,
  createRuntime as createServiceRuntime,
  type FaultPreset,
  type MockControls,
  type RequestLog,
  type ServiceRuntime,
} from "@crvouga/mockingbird-service"
import type { SqliteClient } from "@crvouga/mockingbird-sqlite"
import { rpcBody } from "./errors.js"
import { document, FCM_NAMESPACE, FcmAPI, type FcmAPIOptions, type OutboxQuery } from "./index.js"
import {
  type CredentialRecord,
  isRecord,
  isTokenState,
  type ScriptRecord,
  type Settings,
  type TokenState,
} from "./state.js"

const onSend = (
  rule: Omit<NonNullable<FaultPreset["rules"]>[number], "operationId">,
): NonNullable<FaultPreset["rules"]> => [{ operationId: "SendMessage", ...rule }]

const canned = (code: string) => {
  const built = rpcBody(code)
  return onSend({
    status: built.status,
    body: built.body,
    ...(Object.keys(built.headers).length > 0 ? { headers: built.headers } : {}),
  })
}

/**
 * Named faults for `POST /__admin/faults {"preset": "<name>"}`.
 * `slow` is asserted by its latency, not by waiting it out: Firebase Admin's send timeout is 15s.
 */
export const FCM_PRESETS: Record<string, FaultPreset> = {
  invalid_auth: {
    description: "Send answers 401 UNAUTHENTICATED (no FcmError details) and stores nothing",
    rules: canned("UNAUTHENTICATED"),
  },
  permission_denied: {
    description: "Send answers 403 PERMISSION_DENIED (no FcmError details) and stores nothing",
    rules: canned("PERMISSION_DENIED"),
  },
  invalid_argument: {
    description: "Send answers 400 INVALID_ARGUMENT and stores nothing",
    rules: canned("INVALID_ARGUMENT"),
  },
  unregistered: {
    description: "Send answers 404 NOT_FOUND with FcmError UNREGISTERED and stores nothing",
    rules: canned("UNREGISTERED"),
  },
  sender_mismatch: {
    description: "Send answers 403 with FcmError SENDER_ID_MISMATCH and stores nothing",
    rules: canned("SENDER_ID_MISMATCH"),
  },
  quota_exceeded: {
    description:
      "Send answers 429 RESOURCE_EXHAUSTED with Retry-After, RetryInfo, and FcmError QUOTA_EXCEEDED",
    rules: canned("QUOTA_EXCEEDED"),
  },
  unavailable: {
    description: "Send answers 503 with FcmError UNAVAILABLE (firebase-admin retries status 503)",
    rules: canned("UNAVAILABLE"),
  },
  internal: {
    description: "Send answers 500 with FcmError INTERNAL and stores nothing",
    rules: canned("INTERNAL"),
  },
  slow: {
    description: "Send waits 15s, past the Firebase Admin send timeout",
    rules: onSend({ latencyMs: 15_000 }),
  },
  drop: {
    description: "Send drops the connection before the handler accepts the message",
    rules: onSend({ drop: true }),
  },
  accepted_then_network_drop: {
    description: "Send stores the outbox record, then drops the connection before a response",
    rules: onSend({ effect: "accepted_then_network_drop" }),
  },
}

export type FcmRuntimeOptions = {
  sqlite?: SqliteClient
  clock?: Clock
  seed?: number | string
  adminPrefix?: string
  adminKey?: string
  /** Admin controls to boot with: clock, latency, faults, seed, a starting snapshot. */
  adminControls?: MockControls
  onLog?: (entry: RequestLog) => void
  settings?: Partial<Settings>
}

export type FcmRuntime = ServiceRuntime<FcmAPI>

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })

const adminError = (status: number, message: string) =>
  json(status, { error: { type: "mockingbird_admin", message } })

const outboxQuery = (url: URL): OutboxQuery => {
  const since = url.searchParams.get("since")
  const query: OutboxQuery = {}
  const token = url.searchParams.get("token")
  const platform = url.searchParams.get("platform")
  const project = url.searchParams.get("project")
  const collapseKey = url.searchParams.get("collapseKey")
  const state = url.searchParams.get("state")
  if (token !== null) query.token = token
  if (platform !== null) query.platform = platform
  if (project !== null) query.project = project
  if (collapseKey !== null) query.collapseKey = collapseKey
  if (state !== null) query.state = state
  if (since !== null && /^\d+$/.test(since)) query.since = Number(since)
  return query
}

const credentialMap = (value: unknown): Record<string, CredentialRecord> | string => {
  if (!isRecord(value)) return "credentials must be an object"
  const credentials: Record<string, CredentialRecord> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "string") credentials[key] = { project: entry }
    else if (isRecord(entry) && typeof entry.project === "string") {
      credentials[key] = {
        project: entry.project,
        ...(entry.expired === true ? { expired: true } : {}),
      }
    } else return `credentials.${key} must be a project id or { project, expired? }`
  }
  return credentials
}

const settingsPatch = (body: Record<string, unknown>): Partial<Settings> | string => {
  const patch: Partial<Settings> = {}
  if (body.strict !== undefined) {
    if (typeof body.strict !== "boolean") return "strict: boolean"
    patch.strict = body.strict
  }
  if (body.automaticDelivery !== undefined) {
    if (typeof body.automaticDelivery !== "boolean") return "automaticDelivery: boolean"
    patch.automaticDelivery = body.automaticDelivery
  }
  if (body.collapse !== undefined) {
    if (typeof body.collapse !== "boolean") return "collapse: boolean"
    patch.collapse = body.collapse
  }
  if (body.clockOffsetMs !== undefined) {
    if (typeof body.clockOffsetMs !== "number") return "clockOffsetMs: number"
    patch.clockOffsetMs = body.clockOffsetMs
  }
  if (body.credentials !== undefined) {
    const credentials = credentialMap(body.credentials)
    if (typeof credentials === "string") return credentials
    patch.credentials = credentials
  }
  return patch
}

const tokenInput = (body: Record<string, unknown>) => ({
  token: typeof body.token === "string" ? body.token : "",
  ...(typeof body.platform === "string" ? { platform: body.platform } : {}),
  ...(typeof body.project === "string" ? { project: body.project } : {}),
  ...(typeof body.state === "string" ? { state: body.state } : {}),
  ...(typeof body.appId === "string" ? { appId: body.appId } : {}),
  ...(typeof body.replacement === "string" ? { replacement: body.replacement } : {}),
})

const adminRoutes = (runtime: ServiceRuntime<FcmAPI>): AdminRoutes => ({
  "GET /outbox": ({ url, namespace }) =>
    json(200, { messages: runtime.instance(namespace).outbox(outboxQuery(url)) }),
  "GET /tokens": ({ namespace }) =>
    json(200, {
      tokens: runtime
        .instance(namespace)
        .state.tokens.list({ order: "oldest" })
        .map((row) => row.value),
    }),
  "POST /tokens": ({ body, namespace }) => {
    if (!isRecord(body)) return adminError(400, "expected a JSON object")
    const api = runtime.instance(namespace)
    if (Array.isArray(body.tokens)) {
      const stored = []
      for (const entry of body.tokens) {
        if (!isRecord(entry)) return adminError(400, "tokens[] entries must be objects")
        const result = api.registerToken(tokenInput(entry))
        if (typeof result === "string") return adminError(400, result)
        stored.push(result)
      }
      return json(201, { tokens: stored })
    }
    const result = api.registerToken(tokenInput(body))
    return typeof result === "string" ? adminError(400, result) : json(201, result)
  },
  "POST /tokens/:token/expire": ({ params, body, namespace }) => {
    const token = params.token
    if (!token) return adminError(400, "token is required")
    const replacement =
      isRecord(body) && typeof body.replacement === "string" ? body.replacement : undefined
    const updated = runtime.instance(namespace).setTokenState(token, "expired", replacement)
    return updated ? json(200, updated) : adminError(404, "no token")
  },
  "POST /tokens/:token/state": ({ params, body, namespace }) => {
    const token = params.token
    if (!token) return adminError(400, "token is required")
    if (!isRecord(body) || typeof body.state !== "string" || !isTokenState(body.state)) {
      return adminError(400, "state must be active, expired, unregistered, or sender_mismatch")
    }
    const state: TokenState = body.state
    const replacement = typeof body.replacement === "string" ? body.replacement : undefined
    const updated = runtime.instance(namespace).setTokenState(token, state, replacement)
    return updated ? json(200, updated) : adminError(404, "no token")
  },
  "GET /inbox/:token": ({ params, namespace }) => {
    const token = params.token
    if (!token) return adminError(400, "token is required")
    const inbox = runtime.instance(namespace).inbox(token)
    return inbox ? json(200, { messages: inbox }) : adminError(404, "no token")
  },
  "POST /inbox/:token": ({ params, body, namespace }) => {
    const token = params.token
    if (!token) return adminError(400, "token is required")
    const action =
      isRecord(body) && (body.action === "ack" || body.action === "clear") ? body.action : undefined
    if (!action) return adminError(400, 'action must be "ack" or "clear"')
    const inbox = runtime.instance(namespace).ackInbox(token, action)
    return inbox ? json(200, { messages: inbox }) : adminError(404, "no token")
  },
  "POST /deliver": ({ namespace }) => json(200, runtime.instance(namespace).deliverPending()),
  "POST /messages/:id/deliver": ({ params, namespace }) => {
    const id = params.id
    if (!id) return adminError(400, "id is required")
    return json(200, runtime.instance(namespace).deliverPending(id))
  },
  "POST /messages/:id/drop": ({ params, namespace }) => {
    const id = params.id
    if (!id) return adminError(400, "id is required")
    const message = runtime.instance(namespace).dropMessage(id)
    return message ? json(200, message) : adminError(404, "no message")
  },
  "POST /messages/:id/duplicate": ({ params, namespace }) => {
    const id = params.id
    if (!id) return adminError(400, "id is required")
    const message = runtime.instance(namespace).duplicateMessage(id)
    return typeof message === "string" ? adminError(409, message) : json(200, message)
  },
  "GET /settings": ({ namespace }) => {
    const api = runtime.instance(namespace)
    return json(200, { ...api.state.ensure(), logicalNow: api.logicalNow() })
  },
  "PUT /settings": ({ body, namespace }) => {
    if (!isRecord(body)) return adminError(400, "expected a JSON object")
    const patch = settingsPatch(body)
    if (typeof patch === "string") return adminError(400, patch)
    const api = runtime.instance(namespace)
    return json(200, { ...api.state.updateSettings(patch), logicalNow: api.logicalNow() })
  },
  "POST /time": ({ body, namespace }) => {
    if (!isRecord(body) || typeof body.advanceMs !== "number" || !Number.isFinite(body.advanceMs)) {
      return adminError(400, "advanceMs: number")
    }
    const api = runtime.instance(namespace)
    const settings = api.state.ensure()
    const next = api.state.updateSettings({
      clockOffsetMs: settings.clockOffsetMs + body.advanceMs,
    })
    return json(200, { ...next, logicalNow: api.logicalNow() })
  },
  "GET /scripts": ({ namespace }) =>
    json(200, {
      scripts: runtime
        .instance(namespace)
        .state.scripts.list({ order: "oldest" })
        .map((row) => ({ token: row.id, ...row.value })),
    }),
  "POST /scripts": ({ body, namespace }) => {
    if (!isRecord(body) || typeof body.errorCode !== "string" || typeof body.count !== "number") {
      return adminError(400, "expected { errorCode, count, token?, httpStatus? }")
    }
    if (!Number.isInteger(body.count) || body.count < 1)
      return adminError(400, "count must be a positive integer")
    const script: ScriptRecord = {
      errorCode: body.errorCode,
      count: body.count,
      ...(typeof body.httpStatus === "number" ? { httpStatus: body.httpStatus } : {}),
    }
    const id = typeof body.token === "string" && body.token.length > 0 ? body.token : "*"
    runtime.instance(namespace).putScript(id, script)
    return json(201, { token: id, ...script })
  },
  "DELETE /scripts": ({ url, namespace }) => {
    const token = url.searchParams.get("token")
    const scripts = runtime.instance(namespace).state.scripts
    if (token === null) {
      for (const row of scripts.list()) scripts.delete(row.id)
    } else scripts.delete(token)
    return json(200, { status: "ok" })
  },
})

/**
 * FCM HTTP v1 mock with `/__admin/health`, `/__admin/*`, namespaces, clock, faults, and a journal.
 * Logical message time is the namespace `clockOffsetMs` plus the process-wide runtime clock.
 * `POST /__admin/time` moves one namespace; `POST /__admin/clock` moves every namespace.
 */
export const createRuntime = (options: FcmRuntimeOptions = {}): FcmRuntime => {
  const settings = options.settings
  return createServiceRuntime<FcmAPI>({
    name: FCM_NAMESPACE,
    document,
    state: [{ name: "tokens" }, { name: "messages" }, { name: "scripts" }, { name: "settings" }],
    ...(options.sqlite ? { sqlite: options.sqlite } : {}),
    ...(options.clock ? { clock: options.clock } : {}),
    ...(options.seed !== undefined ? { seed: options.seed } : {}),
    ...(options.adminPrefix !== undefined ? { adminPrefix: options.adminPrefix } : {}),
    ...(options.adminKey !== undefined ? { adminKey: options.adminKey } : {}),
    ...(options.adminControls !== undefined ? { adminControls: options.adminControls } : {}),
    ...(options.onLog ? { onLog: options.onLog } : {}),
    credential: (request) => {
      const header = request.headers.get("authorization")
      const match = header ? /^Bearer\s+(.+)$/i.exec(header.trim()) : undefined
      return match?.[1]?.trim() || undefined
    },
    presets: FCM_PRESETS,
    create: ({ sqlite, namespace, clock }) => {
      const apiOptions: FcmAPIOptions = {
        sqlite,
        namespace,
        now: () => clock.now(),
        ...(settings ? { settings } : {}),
      }
      return new FcmAPI(apiOptions)
    },
    admin: adminRoutes,
  })
}
