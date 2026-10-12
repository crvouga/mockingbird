import {
  type Clock,
  type MockControls,
  type RequestLog,
  type ServiceRuntime,
  createRuntime as serviceRuntime,
  sigV4AccessKeyId,
} from "@crvouga/mockingbird-service"
import type { SqliteClient } from "@crvouga/mockingbird-sqlite"
import { document } from "./generated/openapi.js"
import { IamAPI } from "./index.js"
export type RuntimeOptions = {
  sqlite?: SqliteClient
  clock?: Clock
  seed?: number | string
  region?: string
  accountId?: string
  adminPrefix?: string
  adminKey?: string
  /** Admin controls to boot with: clock, latency, faults, seed, a starting snapshot. */
  adminControls?: MockControls
  onLog?: (entry: RequestLog) => void
}
export type Runtime = ServiceRuntime<IamAPI>
export const createRuntime = (options: RuntimeOptions = {}): Runtime =>
  serviceRuntime({
    name: "iam",
    document,
    credential: sigV4AccessKeyId,
    ...(options.sqlite ? { sqlite: options.sqlite } : {}),
    ...(options.clock ? { clock: options.clock } : {}),
    ...(options.seed !== undefined ? { seed: options.seed } : {}),
    ...(options.adminPrefix !== undefined ? { adminPrefix: options.adminPrefix } : {}),
    ...(options.adminKey !== undefined ? { adminKey: options.adminKey } : {}),
    ...(options.adminControls !== undefined ? { adminControls: options.adminControls } : {}),
    ...(options.onLog ? { onLog: options.onLog } : {}),
    create: ({ sqlite, namespace, clock }) =>
      new IamAPI({
        sqlite,
        namespace,
        now: clock.now,
        ...(options.region ? { region: options.region } : {}),
        ...(options.accountId ? { accountId: options.accountId } : {}),
      }),
  })
