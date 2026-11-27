import {
  createRuntime,
  createService,
  type InstanceContext,
  type MockCreateOptions,
  type OperationHandlers,
  type RuntimeOptions,
  type Service,
  type ServiceOptions,
  type ServiceRuntime,
} from "@crvouga/mockingbird-service"

export type { InstanceContext, OperationHandlers } from "@crvouga/mockingbird-service"
export {
  bodyIssues,
  Collection,
  defineOperations,
  IdSequence,
  jsonResponse,
} from "@crvouga/mockingbird-service"

export type HttpServiceDefinition = Pick<
  RuntimeOptions<Service>,
  "name" | "presets" | "credential" | "state" | "admin"
> &
  Pick<ServiceOptions, "document" | "before" | "unsupported"> &
  Partial<Pick<ServiceOptions, "onError" | "notFound">> & {
    version: string
    defaultPort?: number
    handlers(context: InstanceContext): OperationHandlers
  }

export type HttpRuntimeFactory = (
  options?: MockCreateOptions & Pick<RuntimeOptions<Service>, "onLog">,
) => ServiceRuntime<Service>

/** Structural subset of the fleet boot options consumed by HTTP services. */
type HttpBootControls = {
  [K in "adminKey" | "adminPrefix" | "seed" | "adminControls" | "onLog"]?:
    | RuntimeOptions<Service>[K]
    | undefined
}

export interface HttpServeTarget {
  name: string
  packageVersion: string
  defaultPort: number
  create(values: unknown, common: HttpBootControls): ServiceRuntime<Service>
}

/** Define once for Fetch, a Node listener, or a fleet. Each boot owns its storage and clock. */
export function defineHttpService(definition: HttpServiceDefinition): {
  createRuntime: HttpRuntimeFactory
  serveTarget: HttpServeTarget
} {
  const {
    name,
    version,
    defaultPort = 0,
    document,
    handlers,
    before,
    unsupported,
    notFound = () => Response.json({ error: "not_found" }, { status: 404 }),
    onError = () => Response.json({ error: "internal_error" }, { status: 500 }),
    ...runtimeOptions
  } = definition
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name))
    throw new Error("expected a lowercase hyphenated service name")
  if (!version.trim()) throw new Error("service version is required")
  if (!Number.isInteger(defaultPort) || defaultPort < 0 || defaultPort > 65535)
    throw new Error("defaultPort must be 0-65535")
  const boot = (
    options: MockCreateOptions & Pick<RuntimeOptions<Service>, "onLog"> = {},
  ): ServiceRuntime<Service> =>
    createRuntime({
      ...options,
      ...runtimeOptions,
      name,
      version,
      document,
      create(context) {
        return createService({
          sqlite: context.sqlite,
          namespace: context.namespace,
          now: context.clock.now,
          document,
          handlers: handlers(context),
          notFound,
          onError,
          ...(before && { before }),
          ...(unsupported && { unsupported }),
        })
      },
    })
  return {
    createRuntime: boot,
    serveTarget: {
      name,
      packageVersion: version,
      defaultPort,
      create(_values: unknown, common: HttpBootControls) {
        const { adminKey, adminPrefix, seed, adminControls, onLog } = common
        return boot({
          ...(adminKey !== undefined && { adminKey }),
          ...(adminPrefix !== undefined && { adminPrefix }),
          ...(seed !== undefined && { seed }),
          ...(adminControls !== undefined && { adminControls }),
          ...(onLog && { onLog }),
        })
      },
    },
  }
}
