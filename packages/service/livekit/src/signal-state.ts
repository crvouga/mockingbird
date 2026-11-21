import type { LiveKitAPI, LiveKitEvent } from "./index.js"

const methods = [
  "authorizeJoin",
  "getRoom",
  "getParticipant",
  "listParticipants",
  "join",
  "remove",
  "publish",
  "updateAttributes",
  "deliverPacket",
  "recordMedia",
  "recordConnection",
  "audioBackend",
  "completeAudio",
  "unpublish",
] as const
type Method = (typeof methods)[number]
type AsyncMethod<F> = F extends (...args: infer A) => infer R
  ? (...args: A) => R | Promise<Awaited<R>>
  : never
export type SignalState = { [K in Method]: AsyncMethod<LiveKitAPI[K]> } & {
  observe(listener: (event: LiveKitEvent) => void): () => void
}

/** Bind exactly one runtime namespace to a private MessagePort, never a network endpoint. */
export function hostSignalState(port: MessagePort, api: LiveKitAPI) {
  const unsubscribe = api.observe((event) => port.postMessage({ type: "event", event }))
  const listener = async ({ data }: MessageEvent) => {
    if (data?.type === "dispose") {
      unsubscribe()
      port.removeEventListener("message", listener)
      return
    }
    if (
      data?.type !== "call" ||
      !Number.isSafeInteger(data.id) ||
      !methods.includes(data.method) ||
      !Array.isArray(data.args)
    )
      return
    try {
      const method = api[data.method as Method] as (...args: unknown[]) => unknown
      const value = await method.apply(api, data.args)
      port.postMessage({ type: "result", id: data.id, value })
    } catch (error) {
      port.postMessage({
        type: "result",
        id: data.id,
        failure: error instanceof Error ? error.message : "State request failed",
      })
    }
  }
  port.addEventListener("message", listener)
  port.start()
  return () => {
    unsubscribe()
    port.removeEventListener("message", listener)
    port.close()
  }
}

/** Page-side async state client. JWT keys and persisted collections stay in the worker. */
export function connectSignalState(port: MessagePort, options: { timeoutMs?: number } = {}) {
  const pending = new Map<
    number,
    {
      resolve(value: unknown): void
      reject(error: Error): void
      timer: ReturnType<typeof setTimeout>
    }
  >()
  const observers = new Set<(event: LiveKitEvent) => void>()
  let sequence = 0
  let closed = false
  const listener = ({ data }: MessageEvent) => {
    if (data?.type === "event") {
      for (const observer of observers) observer(data.event)
      return
    }
    if (data?.type !== "result") return
    const call = pending.get(data.id)
    if (!call) return
    pending.delete(data.id)
    clearTimeout(call.timer)
    if (data.failure) call.reject(new Error(data.failure))
    else call.resolve(data.value)
  }
  port.addEventListener("message", listener)
  port.start()
  const call = <K extends Method>(method: K, args: Parameters<LiveKitAPI[K]>) =>
    new Promise<Awaited<ReturnType<LiveKitAPI[K]>>>((resolve, reject) => {
      if (closed) {
        reject(new Error("Signal state port is closed"))
        return
      }
      const id = ++sequence
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error(`Signal state ${method} timed out`))
      }, options.timeoutMs ?? 10000)
      pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer })
      port.postMessage({ type: "call", id, method, args })
    })
  const state: SignalState & { close(): void } = {
    authorizeJoin: (...args) => call("authorizeJoin", args),
    getRoom: (...args) => call("getRoom", args),
    getParticipant: (...args) => call("getParticipant", args),
    listParticipants: (...args) => call("listParticipants", args),
    join: (...args) => call("join", args),
    remove: (...args) => call("remove", args),
    publish: (...args) => call("publish", args),
    updateAttributes: (...args) => call("updateAttributes", args),
    audioBackend: (...args) => call("audioBackend", args),
    completeAudio: (...args) => call("completeAudio", args),
    unpublish: (...args) => call("unpublish", args),
    recordConnection: (...args) => call("recordConnection", args),
    recordMedia: (...args) => call("recordMedia", args),
    deliverPacket: (...args) => call("deliverPacket", args),
    observe(listener) {
      observers.add(listener)
      return () => {
        observers.delete(listener)
      }
    },
    close() {
      if (closed) return
      closed = true
      port.postMessage({ type: "dispose" })
      port.removeEventListener("message", listener)
      port.close()
      observers.clear()
      for (const call of pending.values()) {
        clearTimeout(call.timer)
        call.reject(new Error("Signal state port closed"))
      }
      pending.clear()
    },
  }
  return state
}
