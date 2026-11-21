import { UnsupportedRuntimeError } from "./runtime.js"
export const performance = globalThis.performance
export const PerformanceObserver = globalThis.PerformanceObserver
export const monitorEventLoopDelay = (): never => {
  throw new UnsupportedRuntimeError("perf_hooks.monitorEventLoopDelay")
}
export const createHistogram = (): never => {
  throw new UnsupportedRuntimeError("perf_hooks.createHistogram")
}
