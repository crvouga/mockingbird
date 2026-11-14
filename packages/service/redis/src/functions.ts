/**
 * Redis Functions: the libraries `FUNCTION LOAD` registers and the `FUNCTION` subcommands. The
 * library code runs on the same Lua runtime as `EVAL` (`loadFunctionLibrary` in `lua.ts`); the
 * engine runs `FCALL` / `FCALL_RO`.
 *
 * Differences from Redis (best guess, not oracle-verified): `FUNCTION LIST` shows libraries and
 * their functions in load order (Redis uses hash order), and libraries live only in memory: they
 * are not part of `snapshot()` / fleet archives, and `reset()` drops them. `FUNCTION DUMP` and
 * `RESTORE` return an explicit unsupported error.
 */
import { fromLatin1, globMatch, latin1 } from "./bytes.ts"
import { loadFunctionLibrary, type RegisteredFunction, ScriptFailure } from "./lua.ts"
import {
  arityError,
  arr,
  bulk,
  err,
  int,
  map,
  nil,
  ok,
  queued,
  type Reply,
  syntaxError,
} from "./protocol.ts"

export interface FunctionLibrary {
  name: string
  code: string
  functions: Map<string, RegisteredFunction>
}

const text = (bytes: Uint8Array | undefined): string => (bytes ? latin1(bytes) : "")
const upper = (bytes: Uint8Array | undefined): string => text(bytes).toUpperCase()
/** A Lua (Latin-1) string as a bulk reply. */
const raw = (value: string): Reply => bulk(fromLatin1(value))
const unsupported = (sub: string) =>
  err(`ERR FUNCTION ${sub} is not supported by the Mockingbird Redis emulator`)

/** `#!<engine> name=<library>` on the first line, as `functionExtractLibMetaData` parses it. */
function metadata(code: string): { name: string } | string {
  if (!code.startsWith("#!")) return "ERR Missing library metadata"
  const newline = code.indexOf("\n")
  const line = code.slice(2, newline < 0 ? code.length : newline)
  const [engine = "", ...parts] = line.split(" ").filter(Boolean)
  if (engine.toLowerCase() !== "lua") return `ERR Engine '${engine}' not found`
  let name: string | undefined
  for (const part of parts) {
    if (!part.startsWith("name=")) return `ERR Invalid metadata value given: ${part}`
    name = part.slice(5)
  }
  if (name === undefined) return "ERR Library name was not given"
  if (!/^[A-Za-z0-9_]+$/.test(name))
    return "ERR Library names can only contain letters, numbers, or underscores(_) and must be at least one character long"
  return { name }
}

export class FunctionRegistry {
  private libraries = new Map<string, FunctionLibrary>()

  find(name: string): RegisteredFunction | undefined {
    for (const library of this.libraries.values()) {
      const fn = library.functions.get(name)
      if (fn) return fn
    }
    return undefined
  }

  clear(): void {
    this.libraries.clear()
  }

  command(args: Uint8Array[], apply: boolean): Reply {
    const sub = upper(args[0])
    if (sub === "LOAD") return this.load(args.slice(1), apply)
    if (sub === "LIST") return this.list(args.slice(1))
    if (sub === "DELETE") {
      if (args.length !== 2) return arityError("function|delete")
      if (!this.libraries.has(text(args[1]))) return err("ERR Library not found")
      if (!apply) return queued()
      this.libraries.delete(text(args[1]))
      return ok()
    }
    if (sub === "FLUSH") {
      if (args.length > 2) return arityError("function|flush")
      const mode = upper(args[1])
      if (args.length === 2 && mode !== "ASYNC" && mode !== "SYNC")
        return err("ERR FUNCTION FLUSH only supports SYNC|ASYNC option")
      if (!apply) return queued()
      this.libraries.clear()
      return ok()
    }
    if (sub === "STATS") {
      let functions = 0
      for (const library of this.libraries.values()) functions += library.functions.size
      return map([
        [bulk("running_script"), nil()],
        [
          bulk("engines"),
          map([
            [
              bulk("LUA"),
              map([
                [bulk("libraries_count"), int(this.libraries.size)],
                [bulk("functions_count"), int(functions)],
              ]),
            ],
          ]),
        ],
      ])
    }
    // Functions run to completion inside one command, so nothing is ever running to kill.
    if (sub === "KILL") return err("NOTBUSY No scripts in execution right now.")
    if (sub === "DUMP" || sub === "RESTORE" || sub === "HELP") return unsupported(sub)
    if (args.length === 0) return arityError("function")
    return err(`ERR unknown subcommand '${text(args[0])}'. Try FUNCTION HELP.`)
  }

  private load(args: Uint8Array[], apply: boolean): Reply {
    const replace = args.length === 2 && upper(args[0]) === "REPLACE"
    if (args.length !== 1 && !replace)
      return args.length === 0 ? arityError("function|load") : syntaxError()
    const code = text(args[args.length - 1])
    const meta = metadata(code)
    if (typeof meta === "string") return err(meta)
    if (this.libraries.has(meta.name) && !replace)
      return err(`ERR Library '${meta.name}' already exists`)
    if (!apply) return queued()
    // Blank the metadata line so Lua line numbers match Redis's (the library starts at line 2).
    const newline = code.indexOf("\n")
    const body = newline < 0 ? "" : code.slice(newline)
    let functions: Map<string, RegisteredFunction>
    try {
      functions = loadFunctionLibrary(body)
    } catch (error) {
      if (error instanceof ScriptFailure) return err(error.message)
      throw error
    }
    for (const [name] of functions) {
      for (const library of this.libraries.values()) {
        if (library.name === meta.name) continue
        if (library.functions.has(name)) return err(`ERR Function ${name} already exists`)
      }
    }
    this.libraries.set(meta.name, { name: meta.name, code, functions })
    return bulk(meta.name)
  }

  private list(args: Uint8Array[]): Reply {
    let withCode = false
    let pattern: string | null = null
    for (let i = 0; i < args.length; i++) {
      const option = upper(args[i])
      if (option === "WITHCODE" && !withCode) withCode = true
      else if (option === "LIBRARYNAME" && pattern === null && i + 1 < args.length)
        pattern = text(args[++i])
      else return err(`ERR Unknown argument ${text(args[i])}`)
    }
    const rows: Reply[] = []
    for (const library of this.libraries.values()) {
      if (pattern !== null && !globMatch(pattern, library.name)) continue
      const functions = [...library.functions.values()].map((fn) =>
        map([
          [bulk("name"), raw(fn.name)],
          [bulk("description"), fn.description === null ? nil() : raw(fn.description)],
          [bulk("flags"), arr(fn.flags.map((flag) => bulk(flag)))],
        ]),
      )
      const fields: Array<[Reply, Reply]> = [
        [bulk("library_name"), bulk(library.name)],
        [bulk("engine"), bulk("LUA")],
        [bulk("functions"), arr(functions)],
      ]
      if (withCode) fields.push([bulk("library_code"), raw(library.code)])
      rows.push(map(fields))
    }
    return arr(rows)
  }
}
