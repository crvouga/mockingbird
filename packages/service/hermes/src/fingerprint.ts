import { unsupported } from "./runs.js"

type Node = string | boolean | null | { number: string } | Node[] | Map<string, Node>
const codePointOrder = (a: string, b: string): number => {
  const left = Array.from(a, (c) => c.codePointAt(0) ?? 0)
  const right = Array.from(b, (c) => c.codePointAt(0) ?? 0)
  for (let i = 0; i < Math.min(left.length, right.length); i++) {
    const delta = (left[i] ?? 0) - (right[i] ?? 0)
    if (delta) return delta
  }
  return left.length - right.length
}
const quote = (s: string): string => {
  // Python ensure_ascii=False followed by UTF-8 encoding rejects lone surrogates.
  for (const c of s) {
    const point = c.codePointAt(0) ?? 0
    if (point >= 0xd800 && point <= 0xdfff)
      return unsupported("lone Unicode surrogates cannot be fingerprinted by the pinned provider")
  }
  return JSON.stringify(s)
}
const number = (source: string): string => {
  if (!/[.eE]/.test(source)) return BigInt(source).toString()
  const value = Number(source)
  if (!Number.isFinite(value)) return value < 0 ? "-Infinity" : "Infinity"
  if (Object.is(value, -0)) return "-0.0"
  const [mantissa = "0", exponent = "0"] = value.toExponential().split("e")
  const exp = Number(exponent)
  if (exp < -4 || exp >= 16)
    return `${mantissa}e${exp < 0 ? "-" : "+"}${Math.abs(exp).toString().padStart(2, "0")}`
  const fixed = value.toString()
  return fixed.includes(".") ? fixed : `${fixed}.0`
}
const dump = (node: Node): string => {
  if (node === null || typeof node === "boolean") return JSON.stringify(node)
  if (typeof node === "string") return quote(node)
  if (Array.isArray(node)) return `[${node.map(dump).join(",")}]`
  if (node instanceof Map)
    return `{${[...node.keys()]
      .sort(codePointOrder)
      .map((key) => `${quote(key)}:${dump(node.get(key) ?? null)}`)
      .join(",")}}`
  return number(node.number)
}

/** Tokenize already-valid JSON without throwing away Python int/float distinctions. */
export const canonicalFingerprintInput = (raw: string, memoryKey: string): string => {
  JSON.parse(raw) // syntax validation; the tree below retains original numeric lexemes
  let offset = 0
  const space = () => {
    while (/\s/.test(raw[offset] ?? "") && offset < raw.length) offset++
  }
  const string = (): string => {
    const start = offset++
    while (offset < raw.length) {
      const c = raw[offset++]
      if (c === "\\") offset++
      else if (c === '"') break
    }
    return JSON.parse(raw.slice(start, offset)) as string
  }
  const parse = (): Node => {
    space()
    const c = raw[offset]
    if (c === '"') return string()
    if (c === "{") {
      offset++
      space()
      const out = new Map<string, Node>()
      if (raw[offset] === "}") {
        offset++
        return out
      }
      for (;;) {
        space()
        const key = string()
        space()
        offset++
        out.set(key, parse())
        space()
        if (raw[offset++] === "}") return out
      }
    }
    if (c === "[") {
      offset++
      space()
      const out: Node[] = []
      if (raw[offset] === "]") {
        offset++
        return out
      }
      for (;;) {
        out.push(parse())
        space()
        if (raw[offset++] === "]") return out
      }
    }
    for (const [word, value] of [
      ["true", true],
      ["false", false],
      ["null", null],
    ] as const)
      if (raw.startsWith(word, offset)) {
        offset += word.length
        return value
      }
    const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(raw.slice(offset))
    if (!match) throw new SyntaxError("Invalid JSON")
    offset += match[0].length
    return { number: match[0] }
  }
  return dump(
    new Map<string, Node>([
      ["body", parse()],
      ["gateway_session_key", memoryKey],
    ]),
  )
}
export const sha256 = async (value: string): Promise<string> =>
  Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("")
