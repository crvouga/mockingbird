import { UnsupportedRuntimeError } from "./runtime.js"
export const createServer = (): never => {
  throw new UnsupportedRuntimeError("http2.createServer")
}
export const createSecureServer = (): never => {
  throw new UnsupportedRuntimeError("http2.createSecureServer")
}
export const connect = (): never => {
  throw new UnsupportedRuntimeError("http2.connect")
}
