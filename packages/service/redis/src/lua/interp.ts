/**
 * Lua 5.1 evaluator. A parsed chunk is compiled once into a tree of JS closures; running it never
 * looks at the source again, so a cached script costs the same however long its text is.
 */

import { numberToString } from "./format.ts"
import type { Expr, Proto, Stmt, VarInfo } from "./parse.ts"
import {
  EMPTY,
  LuaError,
  LuaTable,
  type LuaValue,
  pos,
  rtError,
  toNumber,
  typeName,
} from "./value.ts"

/** A local variable that an inner function captures; its value lives in a shared box. */
export interface Box {
  v: LuaValue
}

type Result = LuaValue | LuaValue[]
type Eval = (f: Frame) => LuaValue
type EvalMulti = (f: Frame) => Result
type Exec = (f: Frame) => number

const NORMAL = 0
const BREAK = 1
const RETURN = 2

export class Frame {
  readonly slots: unknown[]
  varargs: LuaValue[] = EMPTY
  ret: Result = undefined
  constructor(
    readonly g: LuaTable,
    nslots: number,
    readonly ups: Box[],
  ) {
    this.slots = new Array(nslots)
  }
}

/** The table `("x"):upper()` looks methods up in. Set once by the string library. */
let stringMethods: LuaTable | null = null
export function setStringMethods(table: LuaTable): void {
  stringMethods = table
}

// ---------------------------------------------------------------------------------------------
// Runtime operations

function typeError(op: string, value: LuaValue, desc: string): never {
  rtError(
    desc === ""
      ? `attempt to ${op} a ${typeName(value)} value`
      : `attempt to ${op} ${desc} (a ${typeName(value)} value)`,
  )
}

export function metaOf(value: LuaValue, event: string): LuaValue {
  return value instanceof LuaTable && value.meta !== null ? value.meta.getStr(event) : undefined
}

export function callValue(fn: LuaValue, args: LuaValue[], desc = ""): Result {
  if (typeof fn === "function") return fn(...args)
  const handler = metaOf(fn, "__call")
  if (handler !== undefined) return callValue(handler, [fn, ...args])
  return typeError("call", fn, desc)
}

export function first(result: Result): LuaValue {
  return Array.isArray(result) ? result[0] : result
}

export function indexValue(obj: LuaValue, key: LuaValue, desc = ""): LuaValue {
  let current = obj
  for (let loop = 0; loop < 100; loop++) {
    let handler: LuaValue
    if (current instanceof LuaTable) {
      const value = current.get(key)
      if (value !== undefined || current.meta === null) return value
      handler = current.meta.getStr("__index")
      if (handler === undefined) return undefined
    } else if (typeof current === "string" && stringMethods !== null) {
      return stringMethods.get(key)
    } else return typeError("index", current, loop === 0 ? desc : "")
    if (typeof handler === "function") return first(handler(current, key))
    current = handler
  }
  return rtError("loop in gettable")
}

function checkKey(key: LuaValue): void {
  if (key === undefined) rtError("table index is nil")
  if (typeof key === "number" && Number.isNaN(key)) rtError("table index is NaN")
}

export function setIndexValue(obj: LuaValue, key: LuaValue, value: LuaValue, desc = ""): void {
  let current = obj
  for (let loop = 0; loop < 100; loop++) {
    let handler: LuaValue
    if (current instanceof LuaTable) {
      if (current.readonly) rtError("Attempt to modify a readonly table")
      if (current.meta === null || current.get(key) !== undefined) {
        checkKey(key)
        current.set(key, value)
        return
      }
      handler = current.meta.getStr("__newindex")
      if (handler === undefined) {
        checkKey(key)
        current.set(key, value)
        return
      }
    } else typeError("index", current, loop === 0 ? desc : "")
    if (typeof handler === "function") {
      handler(current, key, value)
      return
    }
    current = handler
  }
  rtError("loop in settable")
}

const ARITH_EVENT: Record<string, string> = {
  "+": "__add",
  "-": "__sub",
  "*": "__mul",
  "/": "__div",
  "%": "__mod",
  "^": "__pow",
}

function arithNumbers(op: string, x: number, y: number): number {
  switch (op) {
    case "+":
      return x + y
    case "-":
      return x - y
    case "*":
      return x * y
    case "/":
      return x / y
    case "%":
      return x - Math.floor(x / y) * y
    default:
      return x ** y
  }
}

export function arith(op: string, a: LuaValue, b: LuaValue, descA = "", descB = ""): LuaValue {
  const x = toNumber(a)
  const y = toNumber(b)
  if (x !== undefined && y !== undefined) return arithNumbers(op, x, y)
  const event = ARITH_EVENT[op] ?? "__unm"
  const handler = metaOf(a, event) ?? metaOf(b, event)
  if (handler !== undefined) return first(callValue(handler, [a, b]))
  return x === undefined
    ? typeError("perform arithmetic on", a, descA)
    : typeError("perform arithmetic on", b, descB)
}

export function negate(a: LuaValue, desc = ""): LuaValue {
  const x = toNumber(a)
  if (x !== undefined) return -x
  const handler = metaOf(a, "__unm")
  if (handler !== undefined) return first(callValue(handler, [a, a]))
  return typeError("perform arithmetic on", a, desc)
}

export function tostr(value: LuaValue): string | undefined {
  if (typeof value === "string") return value
  if (typeof value === "number") return numberToString(value)
  return undefined
}

export function concat(a: LuaValue, b: LuaValue, descA = "", descB = ""): LuaValue {
  const x = tostr(a)
  const y = tostr(b)
  if (x !== undefined && y !== undefined) return x + y
  const handler = metaOf(a, "__concat") ?? metaOf(b, "__concat")
  if (handler !== undefined) return first(callValue(handler, [a, b]))
  return x === undefined ? typeError("concatenate", a, descA) : typeError("concatenate", b, descB)
}

export function length(value: LuaValue, desc = ""): number {
  if (typeof value === "string") return value.length
  if (value instanceof LuaTable) return value.length()
  return typeError("get length of", value, desc)
}

export function rawEquals(a: LuaValue, b: LuaValue): boolean {
  return a === b
}

export function equals(a: LuaValue, b: LuaValue): boolean {
  if (a === b) return true
  if (a instanceof LuaTable && b instanceof LuaTable) {
    const handler = metaOf(a, "__eq")
    if (handler !== undefined && handler === metaOf(b, "__eq")) {
      const result = first(callValue(handler, [a, b]))
      return result !== undefined && result !== false
    }
  }
  return false
}

function orderError(a: LuaValue, b: LuaValue): never {
  const ta = typeName(a)
  const tb = typeName(b)
  return rtError(
    ta === tb ? `attempt to compare two ${ta} values` : `attempt to compare ${ta} with ${tb}`,
  )
}

export function lessThan(a: LuaValue, b: LuaValue): boolean {
  if (typeof a === "number" && typeof b === "number") return a < b
  if (typeof a === "string" && typeof b === "string") return a < b
  const handler = typeName(a) === typeName(b) ? (metaOf(a, "__lt") ?? metaOf(b, "__lt")) : undefined
  if (handler === undefined) return orderError(a, b)
  const result = first(callValue(handler, [a, b]))
  return result !== undefined && result !== false
}

export function lessEqual(a: LuaValue, b: LuaValue): boolean {
  if (typeof a === "number" && typeof b === "number") return a <= b
  if (typeof a === "string" && typeof b === "string") return a <= b
  if (typeName(a) === typeName(b)) {
    const handler = metaOf(a, "__le") ?? metaOf(b, "__le")
    if (handler !== undefined) {
      const result = first(callValue(handler, [a, b]))
      return result !== undefined && result !== false
    }
    const reverse = metaOf(a, "__lt") ?? metaOf(b, "__lt")
    if (reverse !== undefined) {
      const result = first(callValue(reverse, [b, a]))
      return result === undefined || result === false
    }
  }
  return orderError(a, b)
}

/** The function `pairs` hands back and the generic `for` special-cases. */
export const nextFunction = (table: LuaValue, key: LuaValue): Result => {
  if (!(table instanceof LuaTable)) {
    return rtError(`bad argument #1 to 'next' (table expected, got ${typeName(table)})`)
  }
  const entry = table.next(key)
  return entry === undefined ? undefined : entry
}

/** The iterator `ipairs` hands back: raw reads of t[1], t[2], ... until the first nil. */
export const ipairsIterator = (table: LuaValue, index: LuaValue): Result => {
  const i = (typeof index === "number" ? index : 0) + 1
  const value = table instanceof LuaTable ? table.get(i) : undefined
  return value === undefined ? undefined : [i, value]
}

// ---------------------------------------------------------------------------------------------
// Compiler

const truthy = (value: LuaValue): boolean => value !== undefined && value !== false

function isMulti(e: Expr): boolean {
  return e.k === "call" || e.k === "method" || e.k === "dots"
}

/** What an error message calls an expression: `local 'x'`, `field 'y'`, ... or nothing. */
function describe(e: Expr): string {
  switch (e.k) {
    case "local":
      return `local '${e.v.name}'`
    case "up":
      return `upvalue '${e.name}'`
    case "global":
      return `global '${e.name}'`
    case "index":
      return e.key.k === "str" ? `field '${e.key.v}'` : ""
    case "method":
      return `method '${e.name}'`
    default:
      return ""
  }
}

function compileList(exprs: Expr[]): (f: Frame) => LuaValue[] {
  const count = exprs.length
  if (count === 0) return () => EMPTY
  const last = exprs[count - 1] as Expr
  if (isMulti(last)) {
    const heads = exprs.slice(0, -1).map(compileExpr)
    const tail = compileMulti(last)
    return (f) => {
      const out: LuaValue[] = []
      for (let i = 0; i < heads.length; i++) out.push((heads[i] as Eval)(f))
      const rest = tail(f)
      if (Array.isArray(rest)) for (let i = 0; i < rest.length; i++) out.push(rest[i])
      else out.push(rest)
      return out
    }
  }
  const all = exprs.map(compileExpr)
  return (f) => {
    const out = new Array<LuaValue>(count)
    for (let i = 0; i < count; i++) out[i] = (all[i] as Eval)(f)
    return out
  }
}

function compileMulti(e: Expr): EvalMulti {
  if (e.k === "dots") return (f) => f.varargs
  if (e.k === "call") return compileCall(e)
  if (e.k === "method") return compileMethod(e)
  return compileExpr(e)
}

function compileCall(e: Extract<Expr, { k: "call" }>): EvalMulti {
  const fnE = compileExpr(e.fn)
  const desc = describe(e.fn)
  const line = e.line
  const args = e.args
  const n = args.length
  const lastArg = args[n - 1]
  if (lastArg === undefined || !isMulti(lastArg)) {
    const a = args.map(compileExpr)
    const a0 = a[0] as Eval
    const a1 = a[1] as Eval
    const a2 = a[2] as Eval
    switch (n) {
      case 0:
        return (f) => {
          const fn = fnE(f)
          pos.line = line
          return typeof fn === "function" ? fn() : callValue(fn, EMPTY, desc)
        }
      case 1:
        return (f) => {
          const fn = fnE(f)
          const x = a0(f)
          pos.line = line
          return typeof fn === "function" ? fn(x) : callValue(fn, [x], desc)
        }
      case 2:
        return (f) => {
          const fn = fnE(f)
          const x = a0(f)
          const y = a1(f)
          pos.line = line
          return typeof fn === "function" ? fn(x, y) : callValue(fn, [x, y], desc)
        }
      case 3:
        return (f) => {
          const fn = fnE(f)
          const x = a0(f)
          const y = a1(f)
          const z = a2(f)
          pos.line = line
          return typeof fn === "function" ? fn(x, y, z) : callValue(fn, [x, y, z], desc)
        }
      default:
        break
    }
  }
  const list = compileList(args)
  return (f) => {
    const fn = fnE(f)
    const argv = list(f)
    pos.line = line
    return typeof fn === "function" ? fn(...argv) : callValue(fn, argv, desc)
  }
}

function compileMethod(e: Extract<Expr, { k: "method" }>): EvalMulti {
  const objE = compileExpr(e.obj)
  const name = e.name
  const objDesc = describe(e.obj)
  const callDesc = `method '${name}'`
  const line = e.line
  const list = compileList(e.args)
  return (f) => {
    const obj = objE(f)
    pos.line = line
    const fn =
      obj instanceof LuaTable && obj.hash !== null && obj.hash.has(name)
        ? obj.hash.get(name)
        : indexValue(obj, name, objDesc)
    const argv = list(f)
    pos.line = line
    if (typeof fn === "function") return fn(obj, ...argv)
    return callValue(fn, [obj, ...argv], callDesc)
  }
}

function compileExpr(e: Expr): Eval {
  switch (e.k) {
    case "nil":
      return () => undefined
    case "bool": {
      const value = e.v
      return () => value
    }
    case "num": {
      const value = e.v
      return () => value
    }
    case "str": {
      const value = e.v
      return () => value
    }
    case "dots":
      return (f) => f.varargs[0]
    case "local": {
      const slot = e.v.slot
      return e.v.captured ? (f) => (f.slots[slot] as Box).v : (f) => f.slots[slot] as LuaValue
    }
    case "up": {
      const index = e.index
      return (f) => (f.ups[index] as Box).v
    }
    case "global": {
      const { name, line } = e
      return (f) => {
        const value = f.g.getStr(name)
        if (value !== undefined) return value
        pos.line = line
        return indexValue(f.g, name)
      }
    }
    case "index":
      return compileIndex(e)
    case "call": {
      const call = compileCall(e)
      return (f) => {
        const result = call(f)
        return Array.isArray(result) ? result[0] : result
      }
    }
    case "method": {
      const call = compileMethod(e)
      return (f) => {
        const result = call(f)
        return Array.isArray(result) ? result[0] : result
      }
    }
    case "fn":
      return compileClosure(e.proto)
    case "bin":
      return compileBinary(e)
    case "un":
      return compileUnary(e)
    case "and": {
      const a = compileExpr(e.a)
      const b = compileExpr(e.b)
      return (f) => {
        const x = a(f)
        return x === undefined || x === false ? x : b(f)
      }
    }
    case "or": {
      const a = compileExpr(e.a)
      const b = compileExpr(e.b)
      return (f) => {
        const x = a(f)
        return x === undefined || x === false ? b(f) : x
      }
    }
    case "table":
      return compileTable(e)
    case "paren":
      return compileExpr(e.e)
  }
}

function compileIndex(e: Extract<Expr, { k: "index" }>): Eval {
  const objE = compileExpr(e.obj)
  const desc = describe(e.obj)
  const line = e.line
  if (e.key.k === "str") {
    const name = e.key.v
    return (f) => {
      const obj = objE(f)
      if (obj instanceof LuaTable) {
        const value = obj.hash === null ? undefined : obj.hash.get(name)
        if (value !== undefined || obj.meta === null) return value
      }
      pos.line = line
      return indexValue(obj, name, desc)
    }
  }
  const keyE = compileExpr(e.key)
  return (f) => {
    const obj = objE(f)
    const key = keyE(f)
    if (obj instanceof LuaTable) {
      const value = obj.get(key)
      if (value !== undefined || obj.meta === null) return value
    }
    pos.line = line
    return indexValue(obj, key, desc)
  }
}

function compileBinary(e: Extract<Expr, { k: "bin" }>): Eval {
  const a = compileExpr(e.a)
  const b = compileExpr(e.b)
  const line = e.line
  const descA = describe(e.a)
  const descB = describe(e.b)
  switch (e.op) {
    case "+":
      return (f) => {
        const x = a(f)
        const y = b(f)
        if (typeof x === "number" && typeof y === "number") return x + y
        pos.line = line
        return arith("+", x, y, descA, descB)
      }
    case "-":
      return (f) => {
        const x = a(f)
        const y = b(f)
        if (typeof x === "number" && typeof y === "number") return x - y
        pos.line = line
        return arith("-", x, y, descA, descB)
      }
    case "*":
      return (f) => {
        const x = a(f)
        const y = b(f)
        if (typeof x === "number" && typeof y === "number") return x * y
        pos.line = line
        return arith("*", x, y, descA, descB)
      }
    case "/":
      return (f) => {
        const x = a(f)
        const y = b(f)
        if (typeof x === "number" && typeof y === "number") return x / y
        pos.line = line
        return arith("/", x, y, descA, descB)
      }
    case "%":
      return (f) => {
        const x = a(f)
        const y = b(f)
        pos.line = line
        return arith("%", x, y, descA, descB)
      }
    case "^":
      return (f) => {
        const x = a(f)
        const y = b(f)
        pos.line = line
        return arith("^", x, y, descA, descB)
      }
    case "..":
      return (f) => {
        const x = a(f)
        const y = b(f)
        if (typeof x === "string" && typeof y === "string") return x + y
        pos.line = line
        return concat(x, y, descA, descB)
      }
    case "==":
      return (f) => {
        const x = a(f)
        const y = b(f)
        return x === y || (x instanceof LuaTable && y instanceof LuaTable && equals(x, y))
      }
    case "~=":
      return (f) => {
        const x = a(f)
        const y = b(f)
        return !(x === y || (x instanceof LuaTable && y instanceof LuaTable && equals(x, y)))
      }
    case "<":
      return (f) => {
        const x = a(f)
        const y = b(f)
        if (typeof x === "number" && typeof y === "number") return x < y
        pos.line = line
        return lessThan(x, y)
      }
    case "<=":
      return (f) => {
        const x = a(f)
        const y = b(f)
        if (typeof x === "number" && typeof y === "number") return x <= y
        pos.line = line
        return lessEqual(x, y)
      }
    case ">":
      return (f) => {
        const x = a(f)
        const y = b(f)
        if (typeof x === "number" && typeof y === "number") return x > y
        pos.line = line
        return lessThan(y, x)
      }
    case ">=":
      return (f) => {
        const x = a(f)
        const y = b(f)
        if (typeof x === "number" && typeof y === "number") return x >= y
        pos.line = line
        return lessEqual(y, x)
      }
    default:
      throw new Error(`unknown operator ${e.op}`)
  }
}

function compileUnary(e: Extract<Expr, { k: "un" }>): Eval {
  const a = compileExpr(e.a)
  const desc = describe(e.a)
  const line = e.line
  switch (e.op) {
    case "not":
      return (f) => {
        const x = a(f)
        return x === undefined || x === false
      }
    case "-":
      return (f) => {
        const x = a(f)
        if (typeof x === "number") return -x
        pos.line = line
        return negate(x, desc)
      }
    default:
      return (f) => {
        const x = a(f)
        if (typeof x === "string") return x.length
        pos.line = line
        return length(x, desc)
      }
  }
}

function compileTable(e: Extract<Expr, { k: "table" }>): Eval {
  const line = e.line
  const positional: Expr[] = []
  const keyed: Array<{ key: Eval; value: Eval }> = []
  const order: boolean[] = []
  for (const field of e.fields) {
    if (field.kind === "pos") {
      positional.push(field.value)
      order.push(true)
    } else {
      keyed.push({ key: compileExpr(field.key), value: compileExpr(field.value) })
      order.push(false)
    }
  }
  if (e.fields.length === 0) return () => new LuaTable()
  const lastPos = positional[positional.length - 1]
  const lastIsLast = e.fields[e.fields.length - 1]?.kind === "pos"
  const spread = lastPos !== undefined && lastIsLast && isMulti(lastPos)
  const heads = (spread ? positional.slice(0, -1) : positional).map(compileExpr)
  const tail = spread && lastPos !== undefined ? compileMulti(lastPos) : null
  const allPositional = keyed.length === 0
  return (f) => {
    const table = new LuaTable()
    const items: LuaValue[] = new Array(heads.length)
    let h = 0
    let k = 0
    if (allPositional) {
      for (; h < heads.length; h++) items[h] = (heads[h] as Eval)(f)
    } else {
      for (const isPositional of order) {
        if (isPositional) {
          if (h < heads.length) items[h] = (heads[h] as Eval)(f)
          h++
        } else {
          const entry = keyed[k++] as { key: Eval; value: Eval }
          const key = entry.key(f)
          const value = entry.value(f)
          if (key === undefined || (typeof key === "number" && Number.isNaN(key))) {
            pos.line = line
            checkKey(key)
          }
          table.set(key, value)
        }
      }
    }
    if (tail !== null) {
      const rest = tail(f)
      if (Array.isArray(rest)) for (let i = 0; i < rest.length; i++) items.push(rest[i])
      else items.push(rest)
    }
    while (items.length > 0 && items[items.length - 1] === undefined) items.pop()
    if (items.length > 0) {
      if (table.arr.length === 0 && (table.hash === null || table.hash.size === 0)) {
        table.arr = items
      } else {
        for (let i = 0; i < items.length; i++) table.set(i + 1, items[i])
      }
    }
    return table
  }
}

// -- functions ---------------------------------------------------------------------------------

interface Compiled {
  nslots: number
  paramSlots: number[]
  paramBoxed: boolean[]
  vararg: boolean
  /** No parameter is captured by an inner function, so arguments go straight into slots. */
  unboxed: boolean
  body: Exec
  fromLocal: boolean[]
  upIndex: number[]
}

function compileProto(proto: Proto): Compiled {
  return {
    nslots: proto.nslots,
    paramSlots: proto.params.map((p) => p.slot),
    paramBoxed: proto.params.map((p) => p.captured),
    vararg: proto.vararg,
    unboxed: !proto.params.some((p) => p.captured),
    body: compileBlock(proto.body),
    fromLocal: proto.ups.map((u) => u.fromLocal),
    upIndex: proto.ups.map((u) => u.index),
  }
}

function instantiate(c: Compiled, g: LuaTable, ups: Box[]): (...args: LuaValue[]) => Result {
  const nparams = c.paramSlots.length
  const body = c.body
  const nslots = c.nslots
  const vararg = c.vararg
  const simple = c.unboxed
  const paramSlots = c.paramSlots
  const paramBoxed = c.paramBoxed
  return (...args) => {
    const f = new Frame(g, nslots, ups)
    const slots = f.slots
    if (simple) for (let i = 0; i < nparams; i++) slots[paramSlots[i] as number] = args[i]
    else {
      for (let i = 0; i < nparams; i++) {
        slots[paramSlots[i] as number] = paramBoxed[i] ? { v: args[i] } : args[i]
      }
    }
    if (vararg && args.length > nparams) f.varargs = args.slice(nparams)
    return body(f) === RETURN ? f.ret : EMPTY
  }
}

function compileClosure(proto: Proto): Eval {
  const c = compileProto(proto)
  const count = c.fromLocal.length
  const { fromLocal, upIndex } = c
  const noUps: Box[] = []
  return (f) => {
    let ups = noUps
    if (count > 0) {
      ups = new Array<Box>(count)
      for (let i = 0; i < count; i++) {
        const index = upIndex[i] as number
        ups[i] = (fromLocal[i] ? f.slots[index] : f.ups[index]) as Box
      }
    }
    return instantiate(c, f.g, ups)
  }
}

// -- statements --------------------------------------------------------------------------------

function seq(list: Exec[]): Exec {
  const n = list.length
  if (n === 0) return () => NORMAL
  if (n === 1) return list[0] as Exec
  if (n === 2) {
    const a = list[0] as Exec
    const b = list[1] as Exec
    return (f) => {
      const s = a(f)
      return s !== NORMAL ? s : b(f)
    }
  }
  return (f) => {
    for (let i = 0; i < n; i++) {
      const s = (list[i] as Exec)(f)
      if (s !== NORMAL) return s
    }
    return NORMAL
  }
}

function compileBlock(body: Stmt[]): Exec {
  return seq(body.map(compileStmt))
}

/** Store `value` in a local's slot, boxing it when an inner function captures the variable. */
function declare(v: VarInfo): (f: Frame, value: LuaValue) => void {
  const slot = v.slot
  return v.captured
    ? (f, value) => {
        f.slots[slot] = { v: value }
      }
    : (f, value) => {
        f.slots[slot] = value
      }
}

function compileAssignTarget(target: Expr): (f: Frame, value: LuaValue) => void {
  switch (target.k) {
    case "local": {
      const slot = target.v.slot
      return target.v.captured
        ? (f, value) => {
            ;(f.slots[slot] as Box).v = value
          }
        : (f, value) => {
            f.slots[slot] = value
          }
    }
    case "up": {
      const index = target.index
      return (f, value) => {
        ;(f.ups[index] as Box).v = value
      }
    }
    case "global": {
      const { name, line } = target
      return (f, value) => {
        pos.line = line
        setIndexValue(f.g, name, value)
      }
    }
    default:
      throw new Error("assignment target")
  }
}

function compileStmt(s: Stmt): Exec {
  switch (s.k) {
    case "local": {
      const vars = s.vars
      const values = s.values
      if (vars.length === 1 && values.length === 1) {
        const set = declare(vars[0] as VarInfo)
        const value = compileExpr(values[0] as Expr)
        return (f) => {
          set(f, value(f))
          return NORMAL
        }
      }
      if (values.length === 0) {
        const setters = vars.map(declare)
        return (f) => {
          for (const set of setters) set(f, undefined)
          return NORMAL
        }
      }
      const setters = vars.map(declare)
      const list = compileList(values)
      return (f) => {
        const out = list(f)
        for (let i = 0; i < setters.length; i++)
          (setters[i] as (f: Frame, v: LuaValue) => void)(f, out[i])
        return NORMAL
      }
    }
    case "localfn": {
      const slot = s.v.slot
      const make = compileClosure(s.proto)
      if (s.v.captured) {
        return (f) => {
          const box: Box = { v: undefined }
          f.slots[slot] = box
          box.v = make(f)
          return NORMAL
        }
      }
      return (f) => {
        f.slots[slot] = make(f)
        return NORMAL
      }
    }
    case "assign":
      return compileAssign(s)
    case "call": {
      const call = compileMulti(s.e)
      return (f) => {
        call(f)
        return NORMAL
      }
    }
    case "do":
      return compileBlock(s.body)
    case "while": {
      const cond = compileExpr(s.cond)
      const body = compileBlock(s.body)
      return (f) => {
        for (;;) {
          const c = cond(f)
          if (c === undefined || c === false) return NORMAL
          const r = body(f)
          if (r !== NORMAL) {
            if (r === BREAK) return NORMAL
            return r
          }
        }
      }
    }
    case "repeat": {
      const cond = compileExpr(s.cond)
      const body = compileBlock(s.body)
      return (f) => {
        for (;;) {
          const r = body(f)
          if (r !== NORMAL) {
            if (r === BREAK) return NORMAL
            return r
          }
          const c = cond(f)
          if (c !== undefined && c !== false) return NORMAL
        }
      }
    }
    case "if": {
      const arms = s.arms.map((arm) => ({
        cond: compileExpr(arm.cond),
        body: compileBlock(arm.body),
      }))
      const otherwise = s.otherwise === null ? null : compileBlock(s.otherwise)
      if (arms.length === 1) {
        const arm = arms[0] as { cond: Eval; body: Exec }
        if (otherwise === null) {
          return (f) => {
            const c = arm.cond(f)
            return c === undefined || c === false ? NORMAL : arm.body(f)
          }
        }
        return (f) => {
          const c = arm.cond(f)
          return c === undefined || c === false ? otherwise(f) : arm.body(f)
        }
      }
      return (f) => {
        for (let i = 0; i < arms.length; i++) {
          const arm = arms[i] as { cond: Eval; body: Exec }
          const c = arm.cond(f)
          if (c !== undefined && c !== false) return arm.body(f)
        }
        return otherwise === null ? NORMAL : otherwise(f)
      }
    }
    case "fornum":
      return compileNumericFor(s)
    case "forin":
      return compileGenericFor(s)
    case "return":
      return compileReturn(s)
    case "break":
      return () => BREAK
  }
}

function compileAssign(s: Extract<Stmt, { k: "assign" }>): Exec {
  const { targets, values } = s
  const line = s.line
  if (targets.length === 1 && values.length === 1) {
    const target = targets[0] as Expr
    const value = compileExpr(values[0] as Expr)
    if (target.k === "index") {
      const objE = compileExpr(target.obj)
      const desc = describe(target.obj)
      const tline = target.line
      if (target.key.k === "str") {
        const name = target.key.v
        return (f) => {
          const obj = objE(f)
          const v = value(f)
          if (obj instanceof LuaTable && obj.meta === null && !obj.readonly) obj.set(name, v)
          else {
            pos.line = tline
            setIndexValue(obj, name, v, desc)
          }
          return NORMAL
        }
      }
      const keyE = compileExpr(target.key)
      return (f) => {
        const obj = objE(f)
        const key = keyE(f)
        const v = value(f)
        if (
          obj instanceof LuaTable &&
          obj.meta === null &&
          !obj.readonly &&
          (typeof key === "string" || (typeof key === "number" && !Number.isNaN(key)))
        ) {
          obj.set(key, v)
        } else {
          pos.line = tline
          setIndexValue(obj, key, v, desc)
        }
        return NORMAL
      }
    }
    const set = compileAssignTarget(target)
    return (f) => {
      set(f, value(f))
      return NORMAL
    }
  }
  // General form: evaluate table and key operands, then the values, then assign.
  const prepared = targets.map((target) => {
    if (target.k === "index") {
      const objE = compileExpr(target.obj)
      const keyE = compileExpr(target.key)
      const desc = describe(target.obj)
      const tline = target.line
      return {
        prepare: (f: Frame) => [objE(f), keyE(f)] as [LuaValue, LuaValue],
        store: (_f: Frame, value: LuaValue, operands: [LuaValue, LuaValue] | null) => {
          pos.line = tline
          const [obj, key] = operands as [LuaValue, LuaValue]
          setIndexValue(obj, key, value, desc)
        },
      }
    }
    const set = compileAssignTarget(target)
    return {
      prepare: null,
      store: (f: Frame, value: LuaValue) => {
        pos.line = line
        set(f, value)
      },
    }
  })
  const list = compileList(values)
  return (f) => {
    const operands = prepared.map((p) => (p.prepare === null ? null : p.prepare(f)))
    const out = list(f)
    for (let i = prepared.length - 1; i >= 0; i--) {
      ;(prepared[i] as (typeof prepared)[number]).store(
        f,
        out[i],
        operands[i] as [LuaValue, LuaValue] | null,
      )
    }
    return NORMAL
  }
}

function forNumber(value: LuaValue, what: string): number {
  const n = toNumber(value)
  if (n === undefined) rtError(`'for' ${what} must be a number`)
  return n
}

function compileNumericFor(s: Extract<Stmt, { k: "fornum" }>): Exec {
  const startE = compileExpr(s.start)
  const stopE = compileExpr(s.stop)
  const stepE = s.step === null ? null : compileExpr(s.step)
  const body = compileBlock(s.body)
  const slot = s.v.slot
  const boxed = s.v.captured
  const line = s.line
  return (f) => {
    pos.line = line
    const start = forNumber(startE(f), "initial value")
    const stop = forNumber(stopE(f), "limit")
    const step = stepE === null ? 1 : forNumber(stepE(f), "step")
    const slots = f.slots
    for (let i = start; step > 0 ? i <= stop : stop <= i; i += step) {
      slots[slot] = boxed ? { v: i } : i
      const r = body(f)
      if (r !== NORMAL) {
        if (r === BREAK) break
        return r
      }
    }
    return NORMAL
  }
}

function compileGenericFor(s: Extract<Stmt, { k: "forin" }>): Exec {
  const iter = compileList(s.iter)
  const body = compileBlock(s.body)
  const setters = s.vars.map(declare)
  const nvars = setters.length
  const set0 = setters[0] as (f: Frame, v: LuaValue) => void
  const set1 = setters[1]
  const line = s.line
  return (f) => {
    const init = iter(f)
    const gen = init[0]
    const state = init[1]
    let control = init[2]
    if (gen === nextFunction && state instanceof LuaTable) {
      for (;;) {
        const entry = state.next(control)
        if (entry === undefined) return NORMAL
        control = entry[0]
        set0(f, entry[0])
        if (set1 !== undefined) set1(f, entry[1])
        for (let i = 2; i < nvars; i++)
          (setters[i] as (f: Frame, v: LuaValue) => void)(f, undefined)
        const r = body(f)
        if (r !== NORMAL) {
          if (r === BREAK) return NORMAL
          return r
        }
      }
    }
    if (gen === ipairsIterator && state instanceof LuaTable && typeof control === "number") {
      for (let i = control + 1; ; i++) {
        const value = state.get(i)
        if (value === undefined) return NORMAL
        set0(f, i)
        if (set1 !== undefined) set1(f, value)
        for (let j = 2; j < nvars; j++)
          (setters[j] as (f: Frame, v: LuaValue) => void)(f, undefined)
        const r = body(f)
        if (r !== NORMAL) {
          if (r === BREAK) return NORMAL
          return r
        }
      }
    }
    for (;;) {
      pos.line = line
      const result =
        typeof gen === "function" ? gen(state, control) : callValue(gen, [state, control], "")
      const values = Array.isArray(result) ? result : [result]
      const head = values[0]
      if (head === undefined) return NORMAL
      control = head
      for (let i = 0; i < nvars; i++) (setters[i] as (f: Frame, v: LuaValue) => void)(f, values[i])
      const r = body(f)
      if (r !== NORMAL) {
        if (r === BREAK) return NORMAL
        return r
      }
    }
  }
}

function compileReturn(s: Extract<Stmt, { k: "return" }>): Exec {
  const values = s.values
  if (values.length === 0) {
    return (f) => {
      f.ret = EMPTY
      return RETURN
    }
  }
  if (values.length === 1) {
    const only = values[0] as Expr
    const value = isMulti(only) ? compileMulti(only) : compileExpr(only)
    return (f) => {
      f.ret = value(f)
      return RETURN
    }
  }
  const list = compileList(values)
  return (f) => {
    f.ret = list(f)
    return RETURN
  }
}

/** A compiled chunk: call `instantiate` with the globals table to get the main function. */
export interface Chunk {
  readonly run: (globals: LuaTable) => (...args: LuaValue[]) => Result
}

export function compileChunk(proto: Proto): Chunk {
  const compiled = compileProto(proto)
  return { run: (globals) => instantiate(compiled, globals, []) }
}

export { LuaError, truthy }
