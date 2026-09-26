import {
  type AdminRoutes,
  type Clock,
  type FaultPreset,
  type RequestLog,
  type ServiceRuntime,
  createRuntime as serviceRuntime,
} from "@crvouga/mockingbird-service"
import type { SqliteClient } from "@crvouga/mockingbird-sqlite"
import { document } from "./generated/openapi.js"
import {
  AWS_SECRETS_NAMESPACE,
  AwsSecretsAPI,
  accessKeyCredential,
  type ParameterSeed,
  type SecretSeed,
} from "./index.js"

export const AWS_SECRETS_PRESETS: Record<string, FaultPreset> = {
  throttled: {
    description: "AWS answers ThrottlingException once",
    rules: [
      {
        status: 400,
        body: { __type: "ThrottlingException", message: "Rate exceeded" },
        headers: { "content-type": "application/x-amz-json-1.1" },
      },
    ],
  },
  unavailable: {
    description: "The next request loses its connection",
    rules: [{ drop: true }],
  },
}
export type AwsSecretsRuntimeOptions = {
  sqlite?: SqliteClient
  clock?: Clock
  seed?: number | string
  adminKey?: string
  onLog?: (entry: RequestLog) => void
  region?: string
  accountId?: string
  secrets?: readonly SecretSeed[]
  parameters?: readonly ParameterSeed[]
  deniedNames?: readonly string[]
}
export type AwsSecretsRuntime = ServiceRuntime<AwsSecretsAPI>
const error = (status: number, message: string) =>
  Response.json({ error: { type: "mockingbird_admin", message } }, { status })
const admin = (runtime: ServiceRuntime<AwsSecretsAPI>): AdminRoutes => ({
  "GET /secrets": ({ namespace }) =>
    Response.json({
      secrets: runtime
        .instance(namespace)
        .state.secrets.list()
        .map(({ value }) => ({
          ...value,
          versions: runtime
            .instance(namespace)
            .state.versions.list({ where: (version) => version.secretName === value.name })
            .map(({ value: version }) => ({
              id: version.id,
              stages: version.stages,
              createdAt: version.createdAt,
              value: "[REDACTED]",
              kind: version.valueKind,
            })),
        })),
    }),
  "GET /parameters": ({ namespace }) =>
    Response.json({
      parameters: runtime
        .instance(namespace)
        .state.parameters.list()
        .map(({ value }) => ({ ...value, encodedValue: undefined, value: "[REDACTED]" })),
    }),
  "POST /secrets/:name/rotate": ({ namespace, params, body }) => {
    const input = body as { value?: unknown; binary?: unknown } | null
    if (!input || typeof input.value !== "string") return error(400, "value is required")
    const version = runtime
      .instance(namespace)
      .rotate(params.name as string, input.value, input.binary === true)
    return version
      ? Response.json({ id: version.id, stages: version.stages })
      : error(404, "secret not found")
  },
  "PUT /controls/:name": ({ namespace, params, body }) => {
    const input = body as {
      denied?: unknown
      staleVersionId?: unknown
      decryptionFailure?: unknown
    } | null
    if (!input) return error(400, "control object required")
    const control = {
      denied: input.denied === true,
      ...(typeof input.staleVersionId === "string" ? { staleVersionId: input.staleVersionId } : {}),
      ...(input.decryptionFailure === true ? { decryptionFailure: true } : {}),
    }
    runtime.instance(namespace).state.controls.insert(params.name as string, control)
    return Response.json(control)
  },
})
export const createRuntime = (options: AwsSecretsRuntimeOptions = {}): AwsSecretsRuntime =>
  serviceRuntime({
    name: AWS_SECRETS_NAMESPACE,
    document,
    presets: AWS_SECRETS_PRESETS,
    ...(options.sqlite ? { sqlite: options.sqlite } : {}),
    ...(options.clock ? { clock: options.clock } : {}),
    ...(options.seed !== undefined ? { seed: options.seed } : {}),
    ...(options.adminKey !== undefined ? { adminKey: options.adminKey } : {}),
    ...(options.onLog ? { onLog: options.onLog } : {}),
    credential: accessKeyCredential,
    create: ({ sqlite, namespace, clock }) =>
      new AwsSecretsAPI({
        sqlite,
        namespace,
        now: clock.now,
        ...(options.region ? { region: options.region } : {}),
        ...(options.accountId ? { accountId: options.accountId } : {}),
        ...(options.secrets ? { secrets: options.secrets } : {}),
        ...(options.parameters ? { parameters: options.parameters } : {}),
        ...(options.deniedNames ? { deniedNames: options.deniedNames } : {}),
      }),
    admin,
  })
