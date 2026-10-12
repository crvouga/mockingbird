import {
  type RuntimeOptions,
  type ServiceRuntime,
  createRuntime as serviceRuntime,
} from "@crvouga/mockingbird-service"
import { document, OKTA_NAMESPACE, OktaAPI, type OktaAPIOptions } from "./index.js"
export type OktaRuntimeOptions = Pick<
  RuntimeOptions<OktaAPI>,
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
  Pick<OktaAPIOptions, "fixtures" | "baseUrl" | "tokens">
export type OktaRuntime = ServiceRuntime<OktaAPI>
export function createRuntime(options: OktaRuntimeOptions = {}): OktaRuntime {
  return serviceRuntime({
    ...options,
    name: OKTA_NAMESPACE,
    document,
    create: ({ sqlite, namespace, publicNamespace, adminPrefix, clock, rng }) =>
      new OktaAPI({
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
