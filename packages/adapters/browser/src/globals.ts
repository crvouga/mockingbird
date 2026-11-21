import { clearImmediate, setImmediate } from "node:timers"
import { Buffer } from "buffer"
import process from "process"
import { browserRuntime } from "./runtime.js"

const started = performance.now()
process.hrtime ??= Object.assign(
  (previous?: [number, number]): [number, number] => {
    const nanos = Math.floor(performance.now() * 1e6)
    const difference = nanos - (previous ? previous[0] * 1e9 + previous[1] : 0)
    return [Math.floor(difference / 1e9), difference % 1e9]
  },
  { bigint: () => BigInt(Math.floor(performance.now() * 1e6)) },
)
process.uptime ??= () => (performance.now() - started) / 1000
const output = (write: (value: string) => void) => {
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>()
  const stream = {
    isTTY: false,
    writable: true,
    write(value: unknown, encodingOrCallback?: string | (() => void), callback?: () => void) {
      write(String(value))
      const done = typeof encodingOrCallback === "function" ? encodingOrCallback : callback
      if (done) queueMicrotask(done)
      return true
    },
    on(event: string, callback: (...args: unknown[]) => void) {
      const set = listeners.get(event) ?? new Set()
      set.add(callback)
      listeners.set(event, set)
      return stream
    },
    off(event: string, callback: (...args: unknown[]) => void) {
      listeners.get(event)?.delete(callback)
      return stream
    },
    once(event: string, callback: (...args: unknown[]) => void) {
      const run = (...args: unknown[]) => {
        stream.off(event, run)
        callback(...args)
      }
      return stream.on(event, run)
    },
    emit(event: string, ...args: unknown[]) {
      for (const callback of listeners.get(event) ?? []) callback(...args)
      return (listeners.get(event)?.size ?? 0) > 0
    },
  }
  return stream
}
if (!process.stdout) Object.assign(process, { stdout: output((value) => console.info(value)) })
if (!process.stderr) Object.assign(process, { stderr: output((value) => console.error(value)) })
process.env = browserRuntime.env
const Bun = browserRuntime.bun
const Deno = browserRuntime.deno
const global = globalThis

export { Buffer, Bun, clearImmediate, Deno, global, process, setImmediate }
