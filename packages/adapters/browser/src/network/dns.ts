import { UnsupportedRuntimeError } from "../runtime.js"

type LookupOptions = { all?: boolean; family?: number }
type LookupCallback = (
  error: Error | null,
  address?: string | { address: string; family: number }[],
  family?: number,
) => void

export function lookup(host: string, optionsOrCallback: unknown, callback?: LookupCallback) {
  const done =
    typeof optionsOrCallback === "function" ? (optionsOrCallback as LookupCallback) : callback
  if (!done) throw new TypeError("dns.lookup requires a callback")
  const options =
    typeof optionsOrCallback === "number"
      ? { family: optionsOrCallback }
      : typeof optionsOrCallback === "object" && optionsOrCallback !== null
        ? (optionsOrCallback as LookupOptions)
        : {}
  queueMicrotask(() => {
    for (const key of Object.keys(options)) {
      if (!["family", "all"].includes(key)) {
        done(new UnsupportedRuntimeError(`dns.lookup option ${key}`))
        return
      }
    }
    if (![undefined, 0, 4, 6].includes(options.family)) {
      done(new TypeError("Invalid DNS address family"))
      return
    }
    if (!["localhost", "127.0.0.1", "0.0.0.0", "::1", "[::1]"].includes(host)) {
      done(new UnsupportedRuntimeError("external dns.lookup"))
      return
    }
    const family = host === "localhost" ? options.family || 4 : host.includes(":") ? 6 : 4
    if (options.family && options.family !== family) {
      done(
        Object.assign(new Error("Loopback address does not match requested family"), {
          code: "EAI_ADDRFAMILY",
        }),
      )
      return
    }
    const address = family === 6 ? "::1" : "127.0.0.1"
    if (options.all) done(null, [{ address, family }])
    else done(null, address, family)
  })
}
export function resolveSrv(_host: string, callback: (error: Error) => void) {
  queueMicrotask(() => callback(new UnsupportedRuntimeError("dns.resolveSrv")))
}
export default { lookup, resolveSrv }
