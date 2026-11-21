import { UnsupportedRuntimeError } from "../runtime.js"

export const connect = (): never => {
  throw new UnsupportedRuntimeError("tls.connect")
}
export const createSecureContext = (): never => {
  throw new UnsupportedRuntimeError("tls.createSecureContext")
}
export class TLSSocket {
  constructor() {
    throw new UnsupportedRuntimeError("tls.TLSSocket")
  }
}
export default { connect, createSecureContext, TLSSocket }
