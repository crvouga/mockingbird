import { UnsupportedRuntimeError } from "../runtime.js"

type Subscriber = (message: unknown, name: string | symbol) => void
type Store = { run<Result>(value: unknown, callback: () => Result): Result }
const channels = new Map<string | symbol, Channel>()

export class Channel {
  private subscribers = new Set<Subscriber>()
  private stores = new Map<Store, (message: unknown) => unknown>()
  constructor(readonly name: string | symbol) {}
  get hasSubscribers() {
    return this.subscribers.size > 0
  }
  subscribe(callback: Subscriber) {
    this.subscribers.add(callback)
  }
  unsubscribe(callback: Subscriber) {
    return this.subscribers.delete(callback)
  }
  publish(message: unknown) {
    for (const callback of [...this.subscribers]) callback(message, this.name)
  }
  bindStore(store: Store, transform: (message: unknown) => unknown = (value) => value) {
    this.stores.set(store, transform)
  }
  unbindStore(store: Store) {
    return this.stores.delete(store)
  }
  runStores<Args extends unknown[], Result>(
    message: unknown,
    callback: (...args: Args) => Result,
    thisArg?: unknown,
    ...args: Args
  ): Result {
    let run = () => {
      this.publish(message)
      return callback.apply(thisArg, args)
    }
    for (const [store, transform] of [...this.stores].reverse()) {
      const previous = run
      run = () => store.run(transform(message), previous)
    }
    return run()
  }
}
export const channel = (name: string | symbol) => {
  let found = channels.get(name)
  if (!found) {
    found = new Channel(name)
    channels.set(name, found)
  }
  return found
}
export const hasSubscribers = (name: string | symbol) => channel(name).hasSubscribers
export const subscribe = (name: string | symbol, callback: Subscriber) =>
  channel(name).subscribe(callback)
export const unsubscribe = (name: string | symbol, callback: Subscriber) =>
  channel(name).unsubscribe(callback)
export const tracingChannel = (name: string) => {
  const start = channel(`tracing:${name}:start`)
  const end = channel(`tracing:${name}:end`)
  const asyncStart = channel(`tracing:${name}:asyncStart`)
  const asyncEnd = channel(`tracing:${name}:asyncEnd`)
  const error = channel(`tracing:${name}:error`)
  return {
    start,
    end,
    asyncStart,
    asyncEnd,
    error,
    get hasSubscribers() {
      return [start, end, asyncStart, asyncEnd, error].some((value) => value.hasSubscribers)
    },
    traceSync<Args extends unknown[], Result>(
      callback: (...args: Args) => Result,
      context: Record<string, unknown> = {},
      thisArg?: unknown,
      ...args: Args
    ): Result {
      return start.runStores(context, () => {
        try {
          const value = callback.apply(thisArg, args)
          context.result = value
          return value
        } catch (cause) {
          context.error = cause
          error.publish(context)
          throw cause
        } finally {
          end.publish(context)
        }
      })
    },
    tracePromise(): never {
      throw new UnsupportedRuntimeError("diagnostics_channel.tracePromise")
    },
    traceCallback(): never {
      throw new UnsupportedRuntimeError("diagnostics_channel.traceCallback")
    },
  }
}
