import {
  type AdminRoutes,
  createRuntime as createServiceRuntime,
  jsonRes,
  type RuntimeOptions,
  type ServiceRuntime,
} from "@crvouga/mockingbird-service"
import { document } from "./generated/openapi.js"
import { DOCKER_NAMESPACE, DockerAPI, type DockerAPIOptions } from "./index.js"
import { presets } from "./presets.js"
import { DockerInputError, isRunning, record } from "./state.js"

export type DockerRuntimeOptions = Pick<
  RuntimeOptions<DockerAPI>,
  "sqlite" | "clock" | "seed" | "adminKey" | "onLog" | "journalSize" | "maxCheckpoints"
> &
  Pick<DockerAPIOptions, "onAttach">
export type DockerRuntime = ServiceRuntime<DockerAPI> & { close(): void }

const admin = (runtime: ServiceRuntime<DockerAPI>): AdminRoutes => {
  const respond = (status: number, action: () => unknown) => {
    try {
      return jsonRes(status, action())
    } catch (error) {
      if (error instanceof DockerInputError)
        return jsonRes(error.status, { message: error.message })
      throw error
    }
  }
  return {
    "GET /docker/containers/:id/termination": ({ params, namespace }) =>
      respond(200, () => {
        const c = runtime.instance(namespace).state.find(params.id ?? "")
        return {
          request: c.termination ?? null,
          removalPending: c.removalPending ?? false,
          simulated: true,
        }
      }),
    "GET /docker/waits": ({ namespace }) =>
      jsonRes(200, { pending: runtime.instance(namespace).lifecycle.pending }),
    "POST /docker/containers/:id/complete": ({ params, body, namespace }) =>
      respond(200, () => {
        const result = runtime.instance(namespace).lifecycle.complete(params.id ?? "", body)
        runtime.checkpoint(namespace)
        return result
      }),
    "POST /docker/seed": ({ body, namespace }) =>
      respond(201, () => runtime.instance(namespace).state.seed(body)),
    "POST /docker/restart": ({ body, namespace }) =>
      respond(200, () => {
        if (
          !record(body) ||
          !["preserve", "terminate"].includes(String(body.containers)) ||
          Object.keys(body).some((key) => !["containers", "exitCode"].includes(key)) ||
          (body.exitCode !== undefined &&
            (body.containers !== "terminate" || !Number.isSafeInteger(body.exitCode)))
        )
          throw new DockerInputError(
            400,
            "restart: expected explicit containers preserve or terminate, with optional integer exitCode for terminate",
          )
        const api = runtime.instance(namespace)
        api.cancelTransient()
        if (body.containers === "terminate")
          for (const { value: c } of api.state.containers.list())
            if (isRunning(c)) api.lifecycle.complete(c.id, { exitCode: body.exitCode ?? 137 })
        api.state.updateDaemon({ available: true })
        runtime.checkpoint(namespace)
        return { containers: body.containers, available: true, simulated: true }
      }),
    "POST /docker/daemon": ({ body, namespace }) =>
      respond(200, () => {
        const result = runtime.instance(namespace).state.updateDaemon(body)
        runtime.checkpoint(namespace)
        return result
      }),
    "GET /docker/daemon": ({ namespace }) =>
      jsonRes(200, { ...runtime.instance(namespace).state.daemon(), simulated: true }),
  }
}

/** Standard controls and Timeline coordination; no provider-local history. */
export const createRuntime = (options: DockerRuntimeOptions = {}): DockerRuntime => {
  const instances = new Set<DockerAPI>()
  let closed = false
  const runtime = createServiceRuntime({
    ...options,
    name: DOCKER_NAMESPACE,
    document,
    admin,
    presets,
    beforeRestore: (api) => api.cancelTransient(),
    create: ({ sqlite, namespace, clock }) => {
      const api = new DockerAPI({
        sqlite,
        namespace,
        now: clock.now,
        ...(options.onAttach ? { onAttach: options.onAttach } : {}),
      })
      if (closed) api.close()
      instances.add(api)
      return api
    },
  })
  return {
    ...runtime,
    close: () => {
      closed = true
      for (const api of instances) api.close()
    },
    fetch: (request: Request) => {
      if (closed) return Promise.reject(new TypeError("Docker runtime is closed"))
      const url = new URL(request.url)
      const match = /^(\/ns\/[^/]+)?\/v1\.52(\/.*)$/.exec(url.pathname)
      // Normalize provider aliases before shared operation matching (faults and journal).
      // Administrative endpoints retain their existing, unversioned routing.
      if (match?.[2] && /^(?:\/(?:_ping|version|info)$|\/containers(?:\/|$))/.test(match[2])) {
        url.pathname = `${match[1] ?? ""}${match[2]}`
        request = new Request(url, request)
      }
      return runtime.fetch(request)
    },
  }
}
