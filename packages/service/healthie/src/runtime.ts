import {
  type AdminRoutes,
  type Clock,
  createRuntime as createServiceRuntime,
  createWebhookHub,
  type FaultPreset,
  type RequestLog,
  type ServiceRuntime,
  signers,
  type WebhookEndpoint,
  type WebhookHub,
} from "@crvouga/mockingbird-service"
import type { SqliteClient } from "@crvouga/mockingbird-sqlite"
import { document } from "./generated/openapi.js"
import type { HealthieEvent } from "./graph.js"
import { apiKeyOf, HEALTHIE_NAMESPACE, HealthieAPI, healthieTimestamp } from "./index.js"
import type { BillingItemRecord, Settings, UserRecord } from "./state.js"

/**
 * Which of our backend's receivers each Healthie event type goes to (the routes
 * `HealthieClientService.createWebhook` registers): patient events to `/users/webhook/status`,
 * form events to `/forms/webhooks/status`. Other events (billing) reach only endpoints a suite
 * adds with `PUT /__admin/webhook-endpoints`.
 */
export const HEALTHIE_EVENT_ROUTES: Record<string, string[]> = {
  "/users/webhook/status": ["patient.created", "patient.updated"],
  "/forms/webhooks/status": [
    "requested_form_completion.created",
    "requested_form_completion.updated",
    "form_answer_group.created",
    "form_answer_group.signed",
  ],
}

/**
 * The two receivers for a backend at `baseUrl`, each sent with `x-forwarded-for: <ip>`: our
 * receivers' only check is that this header is one of `HEALTHIE_WEBHOOK_IP_ADDRESS`.
 */
export const healthieEndpoints = (baseUrl: string, ip: string): WebhookEndpoint[] =>
  Object.entries(HEALTHIE_EVENT_ROUTES).map(([path, events]) => ({
    url: `${baseUrl.replace(/\/$/, "")}${path}`,
    events,
    headers: { "x-forwarded-for": ip },
  }))

/** Healthie's staging egress IP, the first value `HEALTHIE_WEBHOOK_IP_ADDRESS` accepts. */
export const DEFAULT_WEBHOOK_IP = "18.206.70.225"

/**
 * Every named Healthie misbehaviour our consumer branches on, switched on with
 * `POST /__admin/faults {"preset": "<name>"}` (add `count` to limit it).
 */
export const HEALTHIE_PRESETS: Record<string, FaultPreset> = {
  invalid_api_key: {
    description: "Every GraphQL call answers errors[{message: 'API Key is Invalid'}] (our 401)",
    rules: [{ operationId: "Graphql", effect: "invalid_api_key" }],
  },
  graphql_500: {
    description: "GraphQL answers an error whose message contains 500 (our 500 branch)",
    rules: [{ operationId: "Graphql", effect: "graphql_500" }],
  },
  validation_messages: {
    description: "Mutations answer messages[{field: 'base', message}] instead of saving (our 400)",
    rules: [{ operationId: "Graphql", effect: "validation_messages" }],
  },
  current_user_null: {
    description: "currentUser resolves null (a revoked key): listFiles throws 401",
    rules: [{ operationId: "Graphql", effect: "current_user_null" }],
  },
  expired_urls: {
    description: "expiring_url / avatar_url come back already expired; downloads answer 403",
    rules: [
      { operationId: "Graphql", effect: "expired_urls" },
      { operationId: "DownloadFile", effect: "expired_urls" },
    ],
  },
  http_500: {
    description: "The GraphQL endpoint answers HTTP 500 (our handleError status branch)",
    rules: [{ operationId: "Graphql", status: 500, body: { error: "Internal Server Error" } }],
  },
  rate_limited: {
    description: "The GraphQL endpoint answers HTTP 429",
    rules: [
      {
        operationId: "Graphql",
        status: 429,
        body: { errors: [{ message: "Too many requests. Please try again later." }] },
      },
    ],
  },
  server_error: {
    description: "Every call answers HTTP 500",
    rules: [{ status: 500, body: { error: "Internal Server Error" } }],
  },
  webhook_duplicate: {
    description: "The next webhook is delivered twice",
    webhook: { mode: "duplicate" },
  },
  webhook_reorder: {
    description: "The next two webhooks arrive swapped",
    webhook: { mode: "reorder" },
  },
  webhook_drop: {
    description: "The next webhook is never delivered",
    webhook: { mode: "drop" },
  },
}

export type HealthieRuntimeOptions = {
  sqlite?: SqliteClient
  clock?: Clock
  seed?: number | string
  adminKey?: string
  onLog?: (entry: RequestLog) => void
  settings?: Partial<Settings>
  /**
   * Deliver webhooks to our backend at `baseUrl` (`/users/webhook/status`,
   * `/forms/webhooks/status`), with `x-forwarded-for: ip` (default {@link DEFAULT_WEBHOOK_IP}).
   */
  webhooks?: {
    baseUrl: string
    ip?: string
    retryDelaysMs?: readonly number[]
    fetch?: (request: Request) => Promise<Response>
  }
}

export type HealthieRuntime = ServiceRuntime<HealthieAPI> & { readonly webhooks: WebhookHub }

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
const adminError = (status: number, message: string) =>
  json(status, { error: { type: "mockingbird_admin", message } })
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
const text = (value: unknown) => (typeof value === "string" ? value : undefined)

/** A user as the admin plane shows it: never the password. */
const publicUser = ({ password: _password, ...user }: UserRecord) => user

const adminRoutes = (runtime: ServiceRuntime<HealthieAPI>): AdminRoutes => {
  const at = () => healthieTimestamp(runtime.clock.now())
  return {
    "GET /users": ({ namespace }) =>
      json(200, {
        users: runtime
          .instance(namespace)
          .state.users.list({ order: "oldest" })
          .map((row) => publicUser(row.value)),
      }),
    "POST /users": ({ body, namespace }) => {
      if (!isRecord(body) || !text(body.email) || !text(body.password)) {
        return adminError(
          400,
          'expected {"email", "password", "first_name"?, "last_name"?, "role"?}',
        )
      }
      const api = runtime.instance(namespace)
      if (api.state.userByEmail(body.email as string)) {
        return adminError(409, `a user with email ${body.email} already exists`)
      }
      const role = body.role === "provider" ? "provider" : "patient"
      const user = api.state.addUser({
        role,
        email: body.email as string,
        password: body.password as string,
        first_name: text(body.first_name) ?? "Test",
        last_name: text(body.last_name) ?? "Member",
        active: body.active !== false,
        ...(text(body.qualifications) ? { qualifications: body.qualifications as string } : {}),
        ...(text(body.dietitian_id) ? { dietitian_id: body.dietitian_id as string } : {}),
        ...(text(body.timezone) ? { timezone: body.timezone as string } : {}),
        ...(text(body.metadata) ? { metadata: body.metadata as string } : {}),
        ...(text(body.phone_number) ? { phone_number: body.phone_number as string } : {}),
        ...(text(body.dob) ? { dob: body.dob as string } : {}),
        ...(text(body.gender) ? { gender: body.gender as string } : {}),
      })
      const apiKey = issueKey(api, user)
      if (role === "patient") {
        api.emit({ resource_id: user.id, resource_id_type: "User", event_type: "patient.created" })
      }
      return json(201, { user: publicUser(user), api_key: apiKey })
    },
    "POST /users/:id/api-keys": ({ params, namespace }) => {
      const api = runtime.instance(namespace)
      const user = api.state.users.get(params.id as string)
      return user
        ? json(201, { api_key: issueKey(api, user) })
        : adminError(404, `no user ${params.id}`)
    },
    "POST /users/:id/archive": ({ params, namespace }) =>
      setActive(runtime.instance(namespace), params.id as string, false, at()),
    "POST /users/:id/unarchive": ({ params, namespace }) =>
      setActive(runtime.instance(namespace), params.id as string, true, at()),
    "POST /offerings": ({ body, namespace }) => {
      if (!isRecord(body) || !text(body.name))
        return adminError(400, 'expected {"name", "price"?, …}')
      const offering = runtime.instance(namespace).state.addOffering({
        name: body.name as string,
        description: text(body.description) ?? null,
        billing_frequency: text(body.billing_frequency) ?? "Monthly",
        currency: text(body.currency) ?? "usd",
        price: text(body.price) ?? String(body.price ?? "0.0"),
        visibility_status: text(body.visibility_status) ?? "visible",
      })
      return json(201, offering)
    },
    "POST /billing-items": ({ body, namespace }) => {
      if (!isRecord(body) || !text(body.sender_id)) {
        return adminError(400, 'expected {"sender_id", "offering_id"?, "is_recurring"?, …}')
      }
      const api = runtime.instance(namespace)
      if (!api.state.users.get(body.sender_id as string)) {
        return adminError(404, `no user ${body.sender_id}`)
      }
      const offering = text(body.offering_id)
        ? api.state.offerings.get(body.offering_id as string)
        : undefined
      if (text(body.offering_id) && !offering)
        return adminError(404, `no offering ${body.offering_id}`)
      const recurring = body.is_recurring !== false && offering?.billing_frequency !== "One-Time"
      const id = api.state.nextId("billing_item")
      const item: BillingItemRecord = {
        id,
        amount_paid: text(body.amount_paid) ?? offering?.price ?? "0.0",
        state: text(body.state) ?? "succeeded",
        is_canceled: false,
        is_recurring: recurring,
        is_paused: false,
        note: null,
        offering_id: offering?.id ?? null,
        sender_id: body.sender_id as string,
        recipient_id: api.state.orgAdmin()?.id ?? null,
        stripe_charge_id: text(body.stripe_charge_id) ?? `ch_mock_${id}`,
        next_payment_date: recurring ? (text(body.next_payment_date) ?? "2099-01-01") : null,
        billing_frequency: recurring ? (offering?.billing_frequency ?? "Monthly") : null,
        created_at: at(),
      }
      api.state.billingItems.insert(item.id, item)
      return json(201, item)
    },
    "POST /form-answer-groups": ({ body, namespace }) => {
      if (!isRecord(body) || !text(body.user_id)) {
        return adminError(
          400,
          'expected {"user_id", "custom_module_form_id"?, "answers"?: {<label|module id>: answer}}',
        )
      }
      const api = runtime.instance(namespace)
      const formId = text(body.custom_module_form_id) ?? "300001"
      const form = api.state.forms.get(formId)
      if (!form) return adminError(404, `no custom module form ${formId}`)
      if (!api.state.users.get(body.user_id as string))
        return adminError(404, `no user ${body.user_id}`)
      const answers = isRecord(body.answers) ? body.answers : {}
      const stamp = at()
      const group = {
        id: api.state.nextId("form_answer_group"),
        name: text(body.name) ?? form.name,
        user_id: body.user_id as string,
        filler_id: text(body.filler_id) ?? (body.user_id as string),
        custom_module_form_id: form.id,
        finished: body.finished !== false,
        form_answers: form.custom_modules.map((module) => {
          const answer = String(answers[module.id] ?? answers[module.label] ?? "")
          return {
            id: api.state.nextId("form_answer"),
            custom_module_id: module.id,
            label: module.label,
            answer,
            displayed_answer: answer,
          }
        }),
        created_at: stamp,
        updated_at: stamp,
      }
      api.state.formAnswerGroups.insert(group.id, group)
      api.emit({
        resource_id: group.id,
        resource_id_type: "FormAnswerGroup",
        event_type: "form_answer_group.created",
      })
      return json(201, group)
    },
    "POST /requested-forms": ({ body, namespace }) => {
      if (!isRecord(body) || !text(body.recipient_id)) {
        return adminError(400, 'expected {"recipient_id", "sender_id"?, "custom_module_form_id"?}')
      }
      const api = runtime.instance(namespace)
      if (!api.state.users.get(body.recipient_id as string)) {
        return adminError(404, `no user ${body.recipient_id}`)
      }
      const sender =
        text(body.sender_id) ??
        api.state.users.list({ where: (u) => u.role === "provider", order: "oldest" }).at(1)?.value
          .id
      const request = {
        id: api.state.nextId("requested_form"),
        recipient_id: body.recipient_id as string,
        sender_id: sender ?? (api.state.orgAdmin()?.id as string),
        custom_module_form_id: text(body.custom_module_form_id) ?? "300001",
        status: "requested",
        created_at: at(),
      }
      api.state.requestedForms.insert(request.id, request)
      api.emit({
        resource_id: request.id,
        resource_id_type: "RequestedFormCompletion",
        event_type: "requested_form_completion.created",
      })
      return json(201, request)
    },
    "POST /events": ({ body, namespace }) => {
      if (!isRecord(body) || !text(body.event_type) || body.resource_id === undefined) {
        return adminError(400, 'expected {"event_type", "resource_id", "resource_id_type"?}')
      }
      const event: HealthieEvent = {
        resource_id: String(body.resource_id),
        resource_id_type: text(body.resource_id_type) ?? "User",
        event_type: body.event_type as string,
      }
      runtime.instance(namespace).emit(event)
      return json(202, event)
    },
    "GET /documents": ({ namespace }) =>
      json(200, {
        documents: runtime
          .instance(namespace)
          .state.documents.list({ order: "oldest" })
          .map((row) => row.value),
      }),
    "GET /settings": ({ namespace }) => json(200, runtime.instance(namespace).state.current()),
    "PUT /settings": ({ body, namespace }) => {
      if (!isRecord(body)) return adminError(400, "expected a JSON object")
      const patch: Partial<Settings> = {}
      if (body.orgApiKeys !== undefined) {
        if (!Array.isArray(body.orgApiKeys)) return adminError(400, "orgApiKeys: string[]")
        patch.orgApiKeys = body.orgApiKeys.map(String)
      }
      if (body.namespace !== undefined) {
        if (body.namespace !== null && typeof body.namespace !== "string") {
          return adminError(400, "namespace: string | null")
        }
        patch.namespace = body.namespace
      }
      if (body.expiringUrlSeconds !== undefined) {
        if (typeof body.expiringUrlSeconds !== "number")
          return adminError(400, "expiringUrlSeconds: number")
        patch.expiringUrlSeconds = body.expiringUrlSeconds
      }
      return json(200, runtime.instance(namespace).state.update(patch))
    },
  }
}

const issueKey = (api: HealthieAPI, user: UserRecord): string => {
  const n = api.state.nextId("api_key")
  const key = `gh_sbox_admin_${user.id}_${n}`
  api.state.apiKeys.insert(key, { key, user_id: user.id, created_at: user.updated_at })
  return key
}

const setActive = (api: HealthieAPI, id: string, active: boolean, at: string) => {
  const user = api.state.users.get(id)
  if (!user) return adminError(404, `no user ${id}`)
  const next = { ...user, active, updated_at: at }
  api.state.users.update(id, next)
  if (user.role === "patient") {
    api.emit({ resource_id: id, resource_id_type: "User", event_type: "patient.updated" })
  }
  return json(200, publicUser(next))
}

/**
 * The Healthie mock with Mockingbird's full service contract: `/health`, `/__admin/*`,
 * namespaces by header, by `/ns/<name>` path prefix, or by API key
 * (`PUT /__admin/credentials {"credentials": {"<key>": "<namespace>"}}`), clock control, fault
 * presets, IP-allowlisted status webhooks and a request journal.
 */
export const createRuntime = (options: HealthieRuntimeOptions = {}): HealthieRuntime => {
  const hook = options.webhooks
  const hub = createWebhookHub({
    // Our receivers check only `x-forwarded-for` against an allowlist; nothing is signed.
    signer: signers.none(),
    ...(hook?.retryDelaysMs ? { retryDelaysMs: hook.retryDelaysMs } : {}),
    ...(hook?.fetch ? { fetch: hook.fetch } : {}),
    endpoints: hook ? healthieEndpoints(hook.baseUrl, hook.ip ?? DEFAULT_WEBHOOK_IP) : [],
  })
  const runtime = createServiceRuntime<HealthieAPI>({
    name: HEALTHIE_NAMESPACE,
    document,
    ...(options.sqlite ? { sqlite: options.sqlite } : {}),
    ...(options.clock ? { clock: options.clock } : {}),
    ...(options.seed !== undefined ? { seed: options.seed } : {}),
    ...(options.adminKey !== undefined ? { adminKey: options.adminKey } : {}),
    ...(options.onLog ? { onLog: options.onLog } : {}),
    credential: apiKeyOf,
    presets: HEALTHIE_PRESETS,
    webhooks: hub,
    create: ({ sqlite, namespace, publicNamespace, clock }) =>
      new HealthieAPI({
        sqlite,
        namespace,
        publicNamespace,
        now: clock.now,
        ...(options.settings ? { settings: options.settings } : {}),
        onEvent: (event) =>
          hub.publish({
            namespace: publicNamespace,
            type: event.event_type,
            body: event,
          }),
      }),
    describe: () => ({ webhooks: hub.endpoints("default").length > 0 ? "on" : "off" }),
    admin: adminRoutes,
  })
  return Object.assign(runtime, { webhooks: hub })
}
