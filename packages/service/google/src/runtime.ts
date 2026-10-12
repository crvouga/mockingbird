import {
  type RuntimeOptions,
  type ServiceRuntime,
  createRuntime as serviceRuntime,
} from "@crvouga/mockingbird-service"
import { document, GOOGLE_NAMESPACE, GoogleAPI, type GoogleAPIOptions } from "./index.js"
export type GoogleRuntimeOptions = Pick<
  RuntimeOptions<GoogleAPI>,
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
  Pick<GoogleAPIOptions, "fixtures" | "baseUrl" | "tokens">
export type GoogleRuntime = ServiceRuntime<GoogleAPI>
export function createRuntime(options: GoogleRuntimeOptions = {}): GoogleRuntime {
  return serviceRuntime({
    ...options,
    name: GOOGLE_NAMESPACE,
    document,
    create: ({ sqlite, namespace, publicNamespace, adminPrefix, clock, rng }) =>
      new GoogleAPI({
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
