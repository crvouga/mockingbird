import {
  createRuntime as createServiceRuntime,
  jsonRes,
  type RuntimeOptions,
  type ServiceRuntime,
} from "@crvouga/mockingbird-service"
import { document } from "./generated/openapi.js"
import { HERMES_NAMESPACE, HermesAPI } from "./index.js"
import { presets } from "./presets.js"
import { HermesError } from "./runs.js"

export type HermesRuntimeOptions = Pick<
  RuntimeOptions<HermesAPI>,
  "sqlite" | "clock" | "seed" | "adminKey" | "onLog" | "journalSize" | "maxCheckpoints"
>
export type HermesRuntime = ServiceRuntime<HermesAPI>

/** Standard controls and Timeline coordination; no provider-local history. */
export const createRuntime = (options: HermesRuntimeOptions = {}): HermesRuntime =>
  createServiceRuntime({
    ...options,
    name: HERMES_NAMESPACE,
    document,
    presets,
    admin: (runtime) => ({
      "POST /hermes/sweep": ({ namespace }) => {
        const result = runtime.instance(namespace).idempotency.sweep()
        runtime.checkpoint(namespace)
        return jsonRes(200, result)
      },
      "POST /hermes/restart": ({ body, namespace }) => {
        try {
          const result = runtime.instance(namespace).idempotency.restart(body)
          runtime.checkpoint(namespace)
          return jsonRes(200, result)
        } catch (error) {
          if (error instanceof HermesError) return jsonRes(error.status, error.envelope())
          throw error
        }
      },
      "POST /hermes/scope": ({ body, namespace }) => {
        try {
          const scope = runtime.instance(namespace).idempotency.setScope(body)
          runtime.checkpoint(namespace)
          return jsonRes(200, { ...scope, simulated: true })
        } catch (error) {
          if (error instanceof HermesError) return jsonRes(error.status, error.envelope())
          throw error
        }
      },
      "POST /hermes/runs/:id/observe": async ({ params, body, namespace }) => {
        try {
          const api = runtime.instance(namespace)
          const run = await api.idempotency.observe(params.id ?? "", body)
          runtime.checkpoint(namespace)
          return jsonRes(200, run)
        } catch (error) {
          if (error instanceof HermesError) return jsonRes(error.status, error.envelope())
          throw error
        }
      },
    }),
    create: ({ sqlite, namespace, clock }) => new HermesAPI({ sqlite, namespace, now: clock.now }),
  })
