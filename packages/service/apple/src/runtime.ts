import {
  type RuntimeOptions,
  type ServiceRuntime,
  createRuntime as serviceRuntime,
} from "@crvouga/mockingbird-service"
import { APPLE_NAMESPACE, AppleAPI, type AppleAPIOptions, document } from "./index.js"
export type AppleRuntimeOptions = Pick<
  RuntimeOptions<AppleAPI>,
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
  Pick<AppleAPIOptions, "fixtures" | "baseUrl" | "tokens">
export type AppleRuntime = ServiceRuntime<AppleAPI>
export function createRuntime(options: AppleRuntimeOptions = {}): AppleRuntime {
  return serviceRuntime({
    ...options,
    name: APPLE_NAMESPACE,
    document,
    create: ({ sqlite, namespace, publicNamespace, adminPrefix, clock, rng }) =>
      new AppleAPI({
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
