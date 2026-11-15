import "zone.js"
import { UnsupportedRuntimeError } from "./runtime.js"

let nextKey = 1
const unavailable = (name: string): never => {
  throw new UnsupportedRuntimeError(`async_hooks.${name}`)
}

/** Requires the build adapter's whole-bundle async/await lowering contract. */
export class AsyncLocalStorage<Store> {
  private key = `mockingbird-context-${nextKey++}`
  getStore(): Store | undefined {
    return Zone.current.get(this.key) as Store | undefined
  }
  run<Args extends unknown[], Result>(
    store: Store,
    callback: (...args: Args) => Result,
    ...args: Args
  ): Result {
    return Zone.current
      .fork({ name: this.key, properties: { [this.key]: store } })
      .run(callback, undefined, args)
  }
  exit<Args extends unknown[], Result>(callback: (...args: Args) => Result, ...args: Args): Result {
    return Zone.current
      .fork({ name: this.key, properties: { [this.key]: undefined } })
      .run(callback, undefined, args)
  }
  enterWith(_store: Store): never {
    return unavailable("AsyncLocalStorage.enterWith; use run")
  }
  disable(): void {
    this.key = `mockingbird-context-${nextKey++}`
  }
  static bind<Args extends unknown[], Result>(callback: (...args: Args) => Result) {
    const zone = Zone.current
    return function (this: unknown, ...args: Args): Result {
      return zone.run(callback, this, args)
    }
  }
  static snapshot() {
    const zone = Zone.current
    return <Args extends unknown[], Result>(
      callback: (...args: Args) => Result,
      ...args: Args
    ): Result => zone.run(callback, undefined, args)
  }
}

export class AsyncResource {
  private readonly zone = Zone.current
  private destroyed = false
  constructor(readonly type: string) {}
  runInAsyncScope<Args extends unknown[], Result>(
    callback: (...args: Args) => Result,
    thisArg?: unknown,
    ...args: Args
  ): Result {
    if (this.destroyed) throw new Error("AsyncResource has been destroyed")
    return this.zone.run(callback, thisArg, args)
  }
  bind<Args extends unknown[], Result>(callback: (...args: Args) => Result) {
    const resource = this
    return function (this: unknown, ...args: Args): Result {
      return resource.runInAsyncScope(callback, this, ...args)
    }
  }
  emitDestroy(): this {
    this.destroyed = true
    return this
  }
  asyncId(): never {
    return unavailable("AsyncResource.asyncId")
  }
  triggerAsyncId(): never {
    return unavailable("AsyncResource.triggerAsyncId")
  }
  static bind = AsyncLocalStorage.bind
}
export const createHook = (): never => unavailable("createHook")
export const executionAsyncId = (): never => unavailable("executionAsyncId")
export const triggerAsyncId = (): never => unavailable("triggerAsyncId")
export const executionAsyncResource = (): never => unavailable("executionAsyncResource")
