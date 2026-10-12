import {
  type RuntimeOptions,
  type ServiceRuntime,
  createRuntime as serviceRuntime,
} from "@crvouga/mockingbird-service"
import { document, MICROSOFT_NAMESPACE, MicrosoftAPI, type MicrosoftAPIOptions } from "./index.js"
export type MicrosoftRuntimeOptions = Pick<
  RuntimeOptions<MicrosoftAPI>,
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
  Pick<MicrosoftAPIOptions, "fixtures" | "baseUrl" | "tokens">
export type MicrosoftRuntime = ServiceRuntime<MicrosoftAPI>
export function createRuntime(options: MicrosoftRuntimeOptions = {}): MicrosoftRuntime {
  return serviceRuntime({
    ...options,
    name: MICROSOFT_NAMESPACE,
    document,
    create: ({ sqlite, namespace, publicNamespace, adminPrefix, clock, rng }) =>
      new MicrosoftAPI({
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
