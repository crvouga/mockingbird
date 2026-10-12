import {
  type RuntimeOptions,
  type ServiceRuntime,
  createRuntime as serviceRuntime,
} from "@crvouga/mockingbird-service"
import { document, LINEAR_NAMESPACE, LinearAPI, type LinearAPIOptions } from "./index.js"
export type LinearRuntimeOptions = Pick<
  RuntimeOptions<LinearAPI>,
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
  Pick<LinearAPIOptions, "fixtures" | "baseUrl" | "tokens">
export type LinearRuntime = ServiceRuntime<LinearAPI>
export function createRuntime(options: LinearRuntimeOptions = {}): LinearRuntime {
  return serviceRuntime({
    ...options,
    name: LINEAR_NAMESPACE,
    document,
    create: ({ sqlite, namespace, publicNamespace, adminPrefix, clock, rng }) =>
      new LinearAPI({
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
