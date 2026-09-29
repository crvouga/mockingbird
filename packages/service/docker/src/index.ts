import type { FetchAPI } from "@crvouga/mockingbird-core"
import {
  type APIOptions,
  annotateResponse,
  bootSqlite,
  createService,
  DroppedConnectionError,
  defineOperations,
  faultEffect,
  forwardRequestContext,
  jsonRes,
  markMutationAccepted,
  type Service,
} from "@crvouga/mockingbird-service"
import type { SqliteClient } from "@crvouga/mockingbird-sqlite"
import type { Hono } from "hono"
import { document, type SupportedOperationId } from "./generated/openapi.js"
import { DockerLifecycle } from "./lifecycle.js"
import { booleanQuery, info, inspect, list, version } from "./observations.js"
import { DockerInputError, DockerState } from "./state.js"

export type { OperationId, SupportedOperationId } from "./generated/openapi.js"
export { document, operationIds, supportedOperationIds } from "./generated/openapi.js"
export type { DockerRuntime, DockerRuntimeOptions } from "./runtime.js"
export { createRuntime } from "./runtime.js"
export const DOCKER_NAMESPACE = "docker"
export type DockerAPIOptions = APIOptions & {
  /** Transport-owned admission callback; ordinary Fetch attach remains unsupported. */
  onAttach?: (api: DockerAPI, request: Request) => Response
}

export class DockerAPI implements FetchAPI {
  readonly app: Hono
  readonly sqlite: SqliteClient
  readonly namespace: string
  readonly state: DockerState
  readonly lifecycle: DockerLifecycle
  private closed = false
  private readonly invalidators = new Set<() => void>()
  private epoch = 0
  get generation(): number {
    return this.epoch
  }
  onInvalidate(listener: () => void): () => void {
    this.invalidators.add(listener)
    return () => {
      this.invalidators.delete(listener)
    }
  }
  cancelTransient(): void {
    this.epoch++
    this.lifecycle.cancelWaits()
    for (const listener of [...this.invalidators]) listener()
  }
  private readonly service: Service
  constructor(options: DockerAPIOptions = {}) {
    this.sqlite = bootSqlite(options.sqlite)
    this.namespace = options.namespace ?? DOCKER_NAMESPACE
    const now = options.now ?? Date.now
    this.state = new DockerState(this.sqlite, this.namespace, now)
    this.lifecycle = new DockerLifecycle(this.state, now)
    const ping = (head: boolean) =>
      new Response(head ? null : "OK", {
        headers: {
          "content-type": "text/plain; charset=utf-8",
          "api-version": "1.52",
          "docker-experimental": "false",
          "builder-version": "2",
          swarm: "inactive",
          "cache-control": "no-cache, no-store, must-revalidate",
          pragma: "no-cache",
        },
      })
    const accepted = (request: Request) => (id: string) => {
      markMutationAccepted(request, { ids: { containerId: id } })
      if (faultEffect(request, "docker.accepted_drop")) throw new DroppedConnectionError()
    }
    this.service = createService({
      document,
      sqlite: this.sqlite,
      namespace: this.namespace,
      now: options.now,
      handlers: defineOperations<SupportedOperationId>({
        SystemPing: () => ping(false),
        SystemPingHead: () => ping(true),
        SystemVersion: () => jsonRes(200, version()),
        SystemInfo: () => jsonRes(200, info(this.state, now)),
        ContainerList: ({ url }) => list(this.state, url, now),
        ContainerInspect: ({ params, url }) =>
          jsonRes(200, inspect(this.state.find(params.id ?? ""), booleanQuery(url, "size"))),
        ContainerStop: ({ params, url, request }) =>
          this.lifecycle.terminate(params.id ?? "", url, request.signal, "stop", accepted(request)),
        ContainerKill: ({ params, url, request }) => {
          try {
            return this.lifecycle.terminate(
              params.id ?? "",
              url,
              request.signal,
              "kill",
              accepted(request),
            )
          } catch (error) {
            if (error instanceof DockerInputError)
              throw new DockerInputError(
                error.status,
                `cannot kill container: ${params.id ?? ""}: ${error.message}`,
              )
            throw error
          }
        },
        ContainerDelete: ({ params, url, request }) =>
          this.lifecycle.remove(params.id ?? "", url, request.signal, accepted(request)),
        ContainerStart: ({ params, url, request }) =>
          this.lifecycle.start(params.id ?? "", url, accepted(request)),
        ContainerWait: ({ params, url, request }) =>
          this.lifecycle.wait(params.id ?? "", url, request.signal),
        ContainerCreate: ({ body, url, request }) => {
          if (body.kind !== "json") return jsonRes(400, { message: "expected JSON body" })
          const created = this.state.create(body.value, url)
          accepted(request)(created.Id)
          return annotateResponse(jsonRes(201, created), { ids: { containerId: created.Id } })
        },
      }),
      notFound: () => jsonRes(404, { message: "page not found" }),
      unsupported: (request, operation) =>
        operation.operationId === "ContainerAttach" && options.onAttach
          ? options.onAttach(this, request)
          : jsonRes(501, { message: `Mockingbird: ${operation.operationId} is not implemented` }),
      onError: (error) => {
        if (error instanceof DockerInputError)
          return jsonRes(error.status, { message: error.message })
        throw error
      },
    })
    this.app = this.service.app
  }
  async fetch(request: Request): Promise<Response> {
    if (this.closed) throw new DroppedConnectionError()
    if (!this.state.daemon().available) return Promise.reject(new DroppedConnectionError())
    const url = new URL(request.url)
    const match = /^\/v(\d+)\.(\d+)(\/.*)$/.exec(url.pathname)
    if (match) {
      const major = Number(match[1])
      const minor = Number(match[2])
      const v = `${match[1]}.${match[2]}`
      const tooNew = major > 1 || (major === 1 && minor > 52)
      const tooOld = major < 1 || (major === 1 && minor < 44)
      if (tooNew || tooOld) {
        const message = tooNew
          ? `client version ${v} is too new. Maximum supported API version is 1.52`
          : `client version ${v} is too old. Minimum supported API version is 1.44, please upgrade your client to a newer version`
        return Promise.resolve(
          major < 1 || (major === 1 && minor < 24)
            ? new Response(message, {
                status: 400,
                headers: { "content-type": "text/plain; charset=utf-8" },
              })
            : jsonRes(400, { message }),
        )
      }
      if (v !== "1.52")
        return Promise.resolve(
          jsonRes(501, { message: `Mockingbird: API ${v} is not implemented; use 1.52` }),
        )
      url.pathname = match[3] ?? "/"
      request = forwardRequestContext(request, new Request(url, request))
    }
    if (request.method === "POST" && /^\/containers\/[^/]+\/start$/.test(url.pathname)) {
      const invalidBody = () =>
        jsonRes(400, {
          message:
            "starting container with non-empty request body was deprecated since API v1.22 and removed in v1.24",
        })
      if (
        request.headers.get("transfer-encoding") === "chunked" ||
        Number(request.headers.get("content-length")) > 7
      ) {
        void request.body?.cancel().catch(() => {})
        return invalidBody()
      }
      // Fetch callers may omit Content-Length. Read at most seven bytes, never tee
      // an unbounded body, and reconstruct the small body for the shared decoder.
      if (request.body) {
        const reader = request.body.getReader()
        const bytes = new Uint8Array(7)
        let length = 0
        try {
          for (;;) {
            const chunk = await reader.read()
            if (chunk.done) break
            if (length + chunk.value.byteLength > 7) {
              void reader.cancel().catch(() => {})
              return invalidBody()
            }
            bytes.set(chunk.value, length)
            length += chunk.value.byteLength
          }
        } finally {
          reader.releaseLock()
        }
        request = forwardRequestContext(
          request,
          new Request(request, { body: bytes.slice(0, length) }),
        )
      }
    }
    return this.service.fetch(request)
  }
  close(): void {
    this.closed = true
    this.cancelTransient()
    this.lifecycle.close()
  }
  async reset(): Promise<void> {
    this.cancelTransient()
    await this.service.reset()
  }
}
