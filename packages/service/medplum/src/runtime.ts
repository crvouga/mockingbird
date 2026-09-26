import {
  type AdminRoutes,
  type Clock,
  createRuntime as createServiceRuntime,
  type FaultPreset,
  NAMESPACE_HEADER,
  type RequestLog,
  type ServiceRuntime,
} from "@crvouga/mockingbird-service"
import type { SqliteClient } from "@crvouga/mockingbird-sqlite"
import { MEDPLUM_VERSION, tooManyRequests, unauthorized } from "@medplum/core"
import type { Resource } from "@medplum/fhirtypes"
import { MedplumAPI, type MedplumAPIOptions, type MedplumUserFixture } from "./api.js"
import { decodeJwt } from "./auth/jwt.js"
import { document } from "./generated/openapi.js"

export const MEDPLUM_NAMESPACE = "medplum"

const outcome = (base: object) => ({
  ...base,
  extension: [
    {
      url: "https://medplum.com/fhir/StructureDefinition/tracing",
      extension: [
        { url: "requestId", valueId: "00000000-0000-4000-8000-000000000000" },
        { url: "traceId", valueId: "00000000-0000-4000-8000-000000000000" },
      ],
    },
  ],
})

const FHIR_JSON = { "content-type": "application/fhir+json; charset=utf-8" }

/**
 * Named Medplum misbehaviours, switched on with `POST /__admin/faults {"preset": "<name>"}`
 * (add `count` to limit it). Bodies are the server's own shapes.
 */
export const MEDPLUM_PRESETS: Record<string, FaultPreset> = {
  rate_limited: {
    description: "Every FHIR request answers 429 Too Many Requests (the server's FHIR quota)",
    rules: [
      { pathPrefix: "/fhir/R4", status: 429, body: outcome(tooManyRequests), headers: FHIR_JSON },
    ],
  },
  token_expired: {
    description:
      "FHIR requests answer 401 as if the access token expired: clients must refresh or sign in again",
    rules: [
      {
        pathPrefix: "/fhir/R4",
        status: 401,
        body: outcome(unauthorized),
        headers: { ...FHIR_JSON, "www-authenticate": 'Bearer realm="medplum"' },
      },
    ],
  },
  server_error: {
    description: "FHIR requests fail with the server's unhandled-error 500",
    rules: [{ pathPrefix: "/fhir/R4", status: 500, body: { msg: "Internal Server Error" } }],
  },
  token_server_error: {
    description: "The token endpoint fails with a 500: sign-in and refresh both fail",
    rules: [
      { operationId: "PostOauth2Token", status: 500, body: { msg: "Internal Server Error" } },
    ],
  },
  write_drop: {
    description: "Creates and batches drop the connection: the write may or may not have happened",
    rules: [
      { operationId: "FhirCreate", drop: true },
      { operationId: "CreatePatient", drop: true },
      { operationId: "FhirBatch", drop: true },
    ],
  },
  slow_search: {
    description: "Searches take 3 s, to exercise client timeouts",
    rules: [
      { operationId: "FhirSearch", delayMs: 3000 },
      { operationId: "SearchPatient", delayMs: 3000 },
    ],
  },
}

export type MedplumRuntimeOptions = Omit<
  MedplumAPIOptions,
  "sqlite" | "now" | "namespace" | "seed"
> & {
  sqlite?: SqliteClient
  clock?: Clock
  /** Seeds generated ids, secrets and fault rates. */
  seed?: number | string
  /** Require `x-mockingbird-admin-key` on `/__admin/*`. */
  adminKey?: string
  onLog?: (entry: RequestLog) => void
  /** Requests each namespace's journal keeps (`GET /__admin/requests`). Default 1000. */
  journalSize?: number
}

export type MedplumRuntime = ServiceRuntime<MedplumAPI>

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
const adminError = (status: number, message: string) =>
  json(status, { error: { type: "mockingbird_admin", message } })
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/** The client a request speaks for: Basic `id:secret`, or a bearer token's `client_id`. */
const credentialOf = (request: Request): string | undefined => {
  const header = request.headers.get("authorization")
  if (!header) return undefined
  const [scheme, value] = header.split(" ")
  if (!value) return undefined
  if (scheme === "Basic") {
    try {
      return atob(value).split(":")[0] || undefined
    } catch {
      return undefined
    }
  }
  if (scheme === "Bearer") {
    const clientId = decodeJwt(value)?.payload.client_id
    return typeof clientId === "string" ? clientId : undefined
  }
  return undefined
}

const resourcesOf = (body: unknown): Resource[] | undefined => {
  if (Array.isArray(body)) return body as Resource[]
  if (!isRecord(body)) return undefined
  if (body.resourceType === "Bundle") {
    return ((body.entry as { resource?: Resource }[] | undefined) ?? [])
      .map((entry) => entry.resource)
      .filter((resource): resource is Resource => resource !== undefined)
  }
  if (typeof body.resourceType === "string") return [body as unknown as Resource]
  return undefined
}

const adminRoutes = (runtime: ServiceRuntime<MedplumAPI>): AdminRoutes => ({
  "GET /medplum": ({ namespace }) => json(200, runtime.instance(namespace).describe()),
  "PUT /medplum/clients/:id": async ({ params, body, namespace }) => {
    const input = isRecord(body) ? body : {}
    try {
      const client = await runtime.instance(namespace).putClient({
        id: params.id as string,
        ...(typeof input.secret === "string" ? { secret: input.secret } : {}),
        ...(typeof input.name === "string" ? { name: input.name } : {}),
        ...(typeof input.projectId === "string" ? { projectId: input.projectId } : {}),
        ...(typeof input.admin === "boolean" ? { admin: input.admin } : {}),
      })
      return json(200, client)
    } catch (error) {
      return adminError(400, error instanceof Error ? error.message : String(error))
    }
  },
  "POST /medplum/users": async ({ body, namespace }) => {
    if (!isRecord(body) || typeof body.email !== "string" || typeof body.password !== "string") {
      return adminError(
        400,
        'expected {"email": "…", "password": "…", "firstName"?, "lastName"?, "profileType"?, "admin"?, "projectId"?}',
      )
    }
    try {
      const created = await runtime
        .instance(namespace)
        .addUser(
          body as unknown as MedplumUserFixture,
          typeof body.projectId === "string" ? body.projectId : undefined,
        )
      return json(201, created)
    } catch (error) {
      return adminError(400, error instanceof Error ? error.message : String(error))
    }
  },
  "POST /medplum/token": async ({ body, namespace }) => {
    const api = runtime.instance(namespace)
    const clientId = isRecord(body) && typeof body.clientId === "string" ? body.clientId : undefined
    try {
      return json(200, { access_token: await api.accessToken(clientId) })
    } catch (error) {
      return adminError(404, error instanceof Error ? error.message : String(error))
    }
  },
  "POST /medplum/resources": async ({ body, namespace, url }) => {
    const resources = resourcesOf(body)
    if (!resources)
      return adminError(400, "expected a resource, an array of resources, or a Bundle")
    const api = runtime.instance(namespace)
    const projectId = url.searchParams.get("projectId") ?? undefined
    try {
      const written = []
      for (const resource of resources) written.push(await api.putResource(resource, projectId))
      return json(200, { resources: written })
    } catch (error) {
      const issue = (error as { outcome?: unknown })?.outcome
      return json(400, {
        error: {
          type: "mockingbird_admin",
          message: error instanceof Error ? error.message : String(error),
          outcome: issue,
        },
      })
    }
  },
  "GET /medplum/resources/:type": async ({ params, namespace }) =>
    json(200, {
      resources: await runtime
        .instance(namespace)
        .resources(params.type as Resource["resourceType"]),
    }),
  "POST /medplum/logins/revoke": ({ namespace }) =>
    json(200, { revoked: runtime.instance(namespace).revokeAllLogins() }),
})

/**
 * The Medplum mock with Mockingbird's full service contract: unauthenticated `/health`, the
 * `/__admin/*` control plane (reset, snapshot/restore, clock, faults, journal, metrics, plus
 * `/__admin/medplum/*` for clients, users, tokens and seed resources), and per-request
 * namespaces — by `x-mockingbird-namespace`, by `/ns/<name>/` base URL prefix, or by client:
 * `PUT /__admin/credentials {"credentials": {"<clientId>": "<namespace>"}}`.
 *
 * Runtime-neutral: serve it with any Fetch-native server (`./server` for Node).
 */
export const createRuntime = (options: MedplumRuntimeOptions = {}): MedplumRuntime => {
  const { sqlite, clock, seed, adminKey, onLog, journalSize, ...apiOptions } = options
  const runtime: ServiceRuntime<MedplumAPI> = createServiceRuntime<MedplumAPI>({
    name: MEDPLUM_NAMESPACE,
    document,
    ...(sqlite ? { sqlite } : {}),
    ...(clock ? { clock } : {}),
    ...(seed !== undefined ? { seed } : {}),
    ...(adminKey !== undefined ? { adminKey } : {}),
    ...(onLog ? { onLog } : {}),
    ...(journalSize !== undefined ? { journalSize } : {}),
    credential: credentialOf,
    presets: MEDPLUM_PRESETS,
    create: ({ sqlite, namespace, publicNamespace, clock }) =>
      new MedplumAPI({
        ...apiOptions,
        sqlite,
        namespace,
        now: clock.now,
        seed: `${seed ?? ""}:${publicNamespace}`,
      }),
    describe: (): Record<string, unknown> => ({
      medplum: MEDPLUM_VERSION,
      baseUrl: runtime.instance().baseUrl,
    }),
    admin: adminRoutes,
  })
  // The token request carries its client id in a form body, which the synchronous credential
  // lookup cannot read: map it here so `PUT /__admin/credentials` routes sign-in too.
  const inner = runtime.fetch
  return Object.assign(runtime, {
    fetch: async (request: Request): Promise<Response> => {
      if (
        request.method === "POST" &&
        !request.headers.has(NAMESPACE_HEADER) &&
        !request.headers.has("authorization") &&
        new URL(request.url).pathname.endsWith("/oauth2/token")
      ) {
        const text = await request.clone().text()
        const clientId = new URLSearchParams(text).get("client_id")
        const namespace = clientId ? runtime.credentials.get(clientId) : undefined
        if (namespace !== undefined) {
          const headers = new Headers(request.headers)
          headers.set(NAMESPACE_HEADER, namespace)
          return inner(new Request(request.url, { method: "POST", headers, body: text }))
        }
      }
      return inner(request)
    },
  })
}
