export { browserRuntime, createBrowserRuntime, UnsupportedRuntimeError } from "./runtime.js"

import { browserRuntime } from "./runtime.js"

/** Install before importing server entrypoints. Never replace a real host runtime. */
export function installBrowserRuntime(): () => void {
  if ("Bun" in globalThis || "Deno" in globalThis)
    throw new Error("A runtime already exists in this realm")
  const previousFetch = globalThis.fetch
  Object.defineProperties(globalThis, {
    Bun: { configurable: true, value: browserRuntime.bun },
    Deno: { configurable: true, value: browserRuntime.deno },
  })
  globalThis.fetch = browserRuntime.fetch as typeof fetch
  let stopped = false
  return () => {
    if (stopped) return
    stopped = true
    Reflect.deleteProperty(globalThis, "Bun")
    Reflect.deleteProperty(globalThis, "Deno")
    globalThis.fetch = previousFetch
    browserRuntime.dispose()
  }
}
