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
  accessKeyCredential,
  DYNAMODB_NAMESPACE,
  DynamoAPI,
  type DynamoSeedTable,
} from "./index.js"

export const DYNAMODB_PRESETS: Record<string, FaultPreset> = {
  throttled: {
    description: "DynamoDB answers ProvisionedThroughputExceededException",
    rules: [
      {
        status: 400,
        body: {
          __type: "com.amazonaws.dynamodb.v20120810#ProvisionedThroughputExceededException",
          message: "The level of configured provisioned throughput was exceeded.",
        },
        headers: { "content-type": "application/x-amz-json-1.0" },
      },
    ],
  },
  unavailable: {
    description: "The next DynamoDB request loses its connection",
    rules: [{ drop: true, count: 1 }],
  },
}
export type DynamoRuntimeOptions = {
  sqlite?: SqliteClient
  clock?: Clock
  seed?: number | string
  adminKey?: string
  onLog?: (entry: RequestLog) => void
  region?: string
  accountId?: string
  tables?: readonly DynamoSeedTable[]
}
export type DynamoRuntime = ServiceRuntime<DynamoAPI>
const admin = (runtime: ServiceRuntime<DynamoAPI>): AdminRoutes => ({
  "GET /tables": ({ namespace }) =>
    Response.json({
      tables: runtime
        .instance(namespace)
        .state.tables.list()
        .map(({ value }) => ({
          ...value,
          itemCount: runtime
            .instance(namespace)
            .state.items.list({ where: (item) => item.table === value.name }).length,
        })),
    }),
  "GET /items": ({ namespace, url }) => {
    const table = url.searchParams.get("table")
    return Response.json({
      items: runtime
        .instance(namespace)
        .state.items.list({ where: (item) => !table || item.table === table })
        .map(({ value }) => value),
    })
  },
  "GET /streams": ({ namespace, url }) => {
    const table = url.searchParams.get("table")
    return Response.json({
      records: runtime
        .instance(namespace)
        .state.streams.list({
          where: (record) => !table || record.table === table,
          order: "oldest",
        })
        .map(({ value }) => value),
    })
  },
})
export const createRuntime = (options: DynamoRuntimeOptions = {}): DynamoRuntime =>
  serviceRuntime({
    name: DYNAMODB_NAMESPACE,
    document,
    presets: DYNAMODB_PRESETS,
    ...(options.sqlite ? { sqlite: options.sqlite } : {}),
    ...(options.clock ? { clock: options.clock } : {}),
    ...(options.seed !== undefined ? { seed: options.seed } : {}),
    ...(options.adminKey !== undefined ? { adminKey: options.adminKey } : {}),
    ...(options.onLog ? { onLog: options.onLog } : {}),
    credential: accessKeyCredential,
    create: ({ sqlite, namespace, clock }) =>
      new DynamoAPI({
        sqlite,
        namespace,
        now: clock.now,
        ...(options.region ? { region: options.region } : {}),
        ...(options.accountId ? { accountId: options.accountId } : {}),
        ...(options.tables ? { tables: options.tables } : {}),
      }),
    admin,
  })
