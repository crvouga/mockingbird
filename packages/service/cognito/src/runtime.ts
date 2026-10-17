import {
  type AdminRoutes,
  type Clock,
  type FaultPreset,
  type MockControls,
  type RequestLog,
  type ServiceRuntime,
  createRuntime as serviceRuntime,
} from "@crvouga/mockingbird-service"
import type { SqliteClient } from "@crvouga/mockingbird-sqlite"
import { type CognitoFixtures, redactedUser, validateCognitoFixtures } from "./fixtures.js"
import { document } from "./generated/openapi.js"
import { accessKeyCredential, COGNITO_NAMESPACE, CognitoAPI } from "./index.js"
import type { CognitoSeedUser } from "./state.js"

export const COGNITO_PRESETS: Record<string, FaultPreset> = {
  throttled: {
    description: "The next Cognito operation returns TooManyRequestsException",
    rules: [
      {
        operationId: "CognitoRpc",
        status: 400,
        body: { __type: "TooManyRequestsException", message: "Rate exceeded" },
      },
    ],
  },
  unavailable: {
    description: "The next Cognito operation returns InternalErrorException",
    rules: [
      {
        operationId: "CognitoRpc",
        status: 500,
        body: { __type: "InternalErrorException", message: "Internal error" },
      },
    ],
  },
}
export type CognitoRuntimeOptions = {
  sqlite?: SqliteClient
  clock?: Clock
  seed?: number | string
  adminPrefix?: string
  adminKey?: string
  /** Admin controls to boot with: clock, latency, faults, seed, a starting snapshot. */
  adminControls?: MockControls
  onLog?: (entry: RequestLog) => void
  poolId?: string
  clientId?: string
  region?: string
  users?: readonly CognitoSeedUser[]
  fixtures?: CognitoFixtures
  baseUrl?: string
}
export type CognitoRuntime = ServiceRuntime<CognitoAPI>
const json = (body: unknown, status = 200) => Response.json(body, { status })
const admin = (runtime: CognitoRuntime): AdminRoutes => ({
  "GET /users": ({ namespace }) =>
    json({
      users: runtime
        .instance(namespace)
        .state.users.list({ order: "oldest" })
        .map(({ value }) => redactedUser(value)),
    }),
  "POST /users": ({ namespace, body }) => {
    const input = body as Partial<CognitoSeedUser> | null
    if (!input || typeof input.username !== "string" || typeof input.password !== "string")
      return json(
        { error: { type: "mockingbird_admin", message: "username and password are required" } },
        400,
      )
    return json(redactedUser(runtime.instance(namespace).state.put(input as CognitoSeedUser)), 201)
  },
  "GET /codes": ({ namespace, url }) => {
    const user = runtime.instance(namespace).state.find(url.searchParams.get("username") ?? "")
    return user
      ? json({
          username: user.username,
          confirmationCode: user.confirmationCode,
          resetCode: user.resetCode,
        })
      : json({ error: { type: "mockingbird_admin", message: "user not found" } }, 404)
  },
  "POST /keys/rotate": async ({ namespace, body }) =>
    json(
      await runtime
        .instance(namespace)
        .rotateSigningKey((body as { retainPrevious?: boolean } | null)?.retainPrevious !== false),
    ),
  "POST /sessions/revoke": ({ namespace, body }) => {
    const username = (body as { username?: unknown } | null)?.username
    if (typeof username !== "string")
      return json({ error: { type: "mockingbird_admin", message: "username is required" } }, 400)
    const api = runtime.instance(namespace)
    for (const row of api.state.sessions.list({
      where: (session) => session.username === username,
    }))
      api.state.sessions.update(row.id, { ...row.value, revoked: true })
    return json({ revoked: true })
  },
})
export const createRuntime = (options: CognitoRuntimeOptions = {}): CognitoRuntime => {
  const fixtures = options.fixtures ? validateCognitoFixtures(options.fixtures) : undefined
  if (fixtures && options.users) throw new Error("fixtures.users and users cannot both be supplied")
  return serviceRuntime({
    name: COGNITO_NAMESPACE,
    document,
    presets: COGNITO_PRESETS,
    ...(options.sqlite ? { sqlite: options.sqlite } : {}),
    ...(options.clock ? { clock: options.clock } : {}),
    ...(options.seed !== undefined ? { seed: options.seed } : {}),
    ...(options.adminPrefix !== undefined ? { adminPrefix: options.adminPrefix } : {}),
    ...(options.adminKey !== undefined ? { adminKey: options.adminKey } : {}),
    ...(options.adminControls !== undefined ? { adminControls: options.adminControls } : {}),
    ...(options.onLog ? { onLog: options.onLog } : {}),
    credential: accessKeyCredential,
    create: ({ sqlite, namespace, publicNamespace, adminPrefix, clock }) =>
      new CognitoAPI({
        sqlite,
        namespace,
        publicNamespace,
        adminPrefix,
        ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
        now: clock.now,
        ...(options.poolId ? { poolId: options.poolId } : {}),
        ...(options.clientId ? { clientId: options.clientId } : {}),
        ...(options.region ? { region: options.region } : {}),
        ...((fixtures?.users ?? options.users) ? { users: fixtures?.users ?? options.users } : {}),
      }),
    admin,
  })
}
