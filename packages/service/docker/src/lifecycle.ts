import { DroppedConnectionError, jsonRes } from "@crvouga/mockingbird-service"
import { booleanQuery } from "./observations.js"
import { parseSignal, stopTimeout } from "./signals.js"
import { DockerInputError, type DockerState, isRunning, record } from "./state.js"

type Waiter = { id: string; condition: string; finish(exitCode: number): void; cancel(): void }

/** Persist transitions; keep only live response handles outside shared storage. */
export class DockerLifecycle {
  private closed = false
  private readonly exits = new Set<(id: string) => void>()
  onExit(listener: (id: string) => void): () => void {
    this.exits.add(listener)
    return () => {
      this.exits.delete(listener)
    }
  }
  private notifyExit(id: string): void {
    for (const listener of [...this.exits]) listener(id)
  }
  private readonly waiters = new Set<Waiter>()
  constructor(
    private readonly state: DockerState,
    private readonly now: () => number,
  ) {}
  get pending(): number {
    return this.waiters.size
  }

  start(id: string, url: URL, accepted: (id: string) => void = () => {}): Response {
    for (const key of ["checkpoint", "checkpoint-dir", "detachKeys"])
      if (url.searchParams.get(key))
        throw new DockerInputError(501, `Mockingbird: start ${key} is not implemented`)
    const c = this.state.find(id)
    if (c.status === "paused")
      throw new DockerInputError(409, "cannot start a paused container, try unpause instead")
    if (isRunning(c)) return new Response(null, { status: 304 })
    if (c.status === "removing" || c.status === "dead")
      throw new DockerInputError(409, "container is marked for removal and cannot be started")
    this.state.containers.update(c.id, {
      ...c,
      status: "running",
      stdinClosed: false,
      exitCode: 0,
      startedAt: new Date(this.now()).toISOString(),
    })
    accepted(c.id)
    return new Response(null, { status: 204 })
  }

  terminate(
    id: string,
    url: URL,
    signal: AbortSignal,
    operation: "stop" | "kill",
    accepted: (id: string) => void = () => {},
  ): Response | Promise<Response> {
    this.checkOpen(signal)
    // Route parsing precedes lookup; stop's signal validation follows the stopped guard.
    const timeout = operation === "stop" ? stopTimeout(url.searchParams.get("t"), 10) : undefined
    let sentSignal =
      operation === "kill" ? parseSignal(url.searchParams.get("signal") || "KILL", true) : 15
    const c = this.state.find(id)
    if (!isRunning(c)) {
      if (operation === "stop") return new Response(null, { status: 304 })
      throw new DockerInputError(409, `container ${c.id} is not running`)
    }
    if (operation === "stop") {
      try {
        sentSignal = parseSignal(
          url.searchParams.get("signal") || String(c.config?.StopSignal || "TERM"),
          false,
        )
      } catch (error) {
        if (error instanceof DockerInputError)
          throw new DockerInputError(500, `cannot stop container: ${id}: ${error.message}`)
        throw error
      }
    }
    this.state.containers.update(c.id, {
      ...c,
      termination: {
        operation,
        signal: sentSignal,
        requestedAt: new Date(this.now()).toISOString(),
        ...(operation === "stop"
          ? {
              timeout: stopTimeout(
                url.searchParams.get("t"),
                Number(c.config?.StopTimeout ?? timeout),
              ),
            }
          : {}),
      },
    })
    accepted(c.id)
    if (operation === "kill" && sentSignal !== 9) return new Response(null, { status: 204 })
    return this.terminationReply(c.id, signal, "not-running")
  }

  remove(
    id: string,
    url: URL,
    signal: AbortSignal,
    accepted: (id: string) => void = () => {},
  ): Response | Promise<Response> {
    this.checkOpen(signal)
    if (booleanQuery(url, "link"))
      throw new DockerInputError(501, "Mockingbird: link removal is not implemented")
    const c = this.state.find(id)
    if (c.removalPending || c.status === "removing")
      throw new DockerInputError(409, `removal of container ${id} is already in progress`)
    if (isRunning(c)) {
      if (!booleanQuery(url, "force"))
        throw new DockerInputError(
          409,
          `cannot remove container "${id}": ${c.status === "paused" ? "container is paused and must be unpaused first" : `container is ${c.status}: stop the container before removing or force remove`}`,
        )
      this.state.containers.update(c.id, {
        ...c,
        removalPending: true,
        termination: {
          operation: "remove",
          signal: 9,
          requestedAt: new Date(this.now()).toISOString(),
        },
      })
      accepted(c.id)
      return this.terminationReply(c.id, signal, "removed")
    }
    this.state.containers.delete(c.id)
    this.notify(c.id, c.exitCode, true)
    this.notifyExit(c.id)
    accepted(c.id)
    return new Response(null, { status: 204 })
  }

  private checkOpen(signal: AbortSignal): void {
    if (this.closed || signal.aborted) throw new DroppedConnectionError()
  }
  private terminationReply(id: string, signal: AbortSignal, condition: string): Promise<Response> {
    return new Promise((resolve, reject) => {
      const release = () => {
        this.waiters.delete(waiter)
        signal.removeEventListener("abort", abort)
      }
      const abort = () => {
        release()
        reject(new DroppedConnectionError())
      }
      const waiter: Waiter = {
        id,
        condition,
        finish: () => {
          release()
          resolve(new Response(null, { status: 204 }))
        },
        cancel: abort,
      }
      this.waiters.add(waiter)
      signal.addEventListener("abort", abort, { once: true })
      if (signal.aborted) abort()
    })
  }
  private notify(id: string, exitCode: number, removed: boolean): void {
    for (const waiter of this.waiters)
      if (waiter.id === id && (removed || waiter.condition !== "removed")) waiter.finish(exitCode)
  }

  complete(id: string, value: unknown) {
    if (
      !record(value) ||
      Object.keys(value).some((k) => k !== "exitCode") ||
      !Number.isSafeInteger(value.exitCode)
    )
      throw new DockerInputError(400, "completion: expected {exitCode: integer}")
    const c = this.state.find(id)
    if (!isRunning(c)) throw new DockerInputError(409, "container is not running")
    const exitCode = value.exitCode as number
    this.state.containers.update(c.id, {
      ...c,
      status: "exited",
      exitCode,
      finishedAt: new Date(this.now()).toISOString(),
    })
    const removed = c.hostConfig.AutoRemove === true || c.removalPending === true
    if (removed) this.state.containers.delete(c.id)
    this.notify(c.id, exitCode, removed)
    this.notifyExit(c.id)
    return { id: c.id, exitCode, removed, simulated: true }
  }

  wait(id: string, url: URL, signal: AbortSignal): Response {
    if (this.closed) throw new DOMException("Docker runtime is closed", "AbortError")
    const condition = url.searchParams.get("condition") || "not-running"
    if (!["not-running", "next-exit", "removed"].includes(condition))
      throw new DockerInputError(400, `invalid condition: ${JSON.stringify(condition)}`)
    const c = this.state.find(id)
    if (signal.aborted) throw new DOMException("The operation was aborted", "AbortError")
    if (condition === "not-running" && !isRunning(c))
      return jsonRes(200, { StatusCode: c.exitCode })
    let cleanup = () => {}
    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        let settled = false
        const release = () => {
          if (settled) return false
          settled = true
          this.waiters.delete(waiter)
          signal.removeEventListener("abort", abort)
          return true
        }
        const abort = () => {
          if (release()) controller.error(new DOMException("Docker wait canceled", "AbortError"))
        }
        const waiter: Waiter = {
          id: c.id,
          condition,
          finish: (exitCode) => {
            if (!release()) return
            controller.enqueue(
              new TextEncoder().encode(`${JSON.stringify({ StatusCode: exitCode })}\n`),
            )
            controller.close()
          },
          cancel: abort,
        }
        cleanup = () => {
          release()
        }
        this.waiters.add(waiter)
        signal.addEventListener("abort", abort, { once: true })
        if (signal.aborted) abort()
      },
      cancel: () => cleanup(),
    })
    return new Response(stream, { headers: { "content-type": "application/json" } })
  }

  close(): void {
    this.closed = true
    this.cancelWaits()
  }

  cancelWaits(): void {
    for (const waiter of this.waiters) waiter.cancel()
  }
}
