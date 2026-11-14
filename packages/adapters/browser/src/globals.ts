import { clearImmediate, setImmediate } from "node:timers"
import { Buffer } from "buffer"
import process from "process"
import { browserRuntime } from "./runtime.js"

process.env = browserRuntime.env
const Bun = browserRuntime.bun
const Deno = browserRuntime.deno
const global = globalThis

export { Buffer, Bun, clearImmediate, Deno, global, process, setImmediate }
