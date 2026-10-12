import {
  type RuntimeOptions,
  type ServiceRuntime,
  createRuntime as serviceRuntime,
} from "@crvouga/mockingbird-service"
import {
  document,
  MONGOATLAS_NAMESPACE,
  MongoAtlasAPI,
  type MongoAtlasAPIOptions,
} from "./index.js"
export type MongoAtlasRuntimeOptions = Pick<
  RuntimeOptions<MongoAtlasAPI>,
  | "sqlite"
  | "clock"
  | "seed"
  | "adminPrefix"
  | "adminKey"
  | "adminControls"
  | "onLog"
  | "journalSize"
  | "maxCheckpoints"
> &
  Pick<MongoAtlasAPIOptions, "fixtures" | "baseUrl" | "tokens">
export type MongoAtlasRuntime = ServiceRuntime<MongoAtlasAPI>
export function createRuntime(options: MongoAtlasRuntimeOptions = {}): MongoAtlasRuntime {
  return serviceRuntime({
    ...options,
    name: MONGOATLAS_NAMESPACE,
    document,
    create: ({ sqlite, namespace, publicNamespace, adminPrefix, clock, rng }) =>
      new MongoAtlasAPI({
        sqlite,
        namespace,
        publicNamespace,
        adminPrefix,
        now: clock.now,
        random: rng.next,
        ...(options.fixtures ? { fixtures: options.fixtures } : {}),
        ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
        ...(options.tokens ? { tokens: options.tokens } : {}),
      }),
  })
}
