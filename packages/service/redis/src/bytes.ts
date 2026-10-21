/** Byte helpers. Keys and Lua strings are Latin-1 so client bytes round-trip. */

export function latin1(bytes: Uint8Array): string {
  let out = ""
  for (let i = 0; i < bytes.length; i++) out += String.fromCharCode(bytes[i] ?? 0)
  return out
}

export function fromLatin1(value: string): Uint8Array {
  const out = new Uint8Array(value.length)
  for (let i = 0; i < value.length; i++) out[i] = value.charCodeAt(i) & 0xff
  return out
}

export function utf8(value: string): Uint8Array {
  return new TextEncoder().encode(value)
}

export function utf8Text(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes)
}

export function eqBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

export function cmpBytes(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0)
    if (d !== 0) return d
  }
  return a.length - b.length
}

const INT64_MAX = 9223372036854775807n
const INT64_MIN = -9223372036854775808n

export function parseI64(bytes: Uint8Array): bigint | null {
  const text = latin1(bytes)
  if (!/^-?\d+$/.test(text)) return null
  try {
    const value = BigInt(text)
    if (value > INT64_MAX || value < INT64_MIN) return null
    return value
  } catch {
    return null
  }
}

export function intReply(value: bigint): number | bigint {
  if (value <= BigInt(Number.MAX_SAFE_INTEGER) && value >= BigInt(Number.MIN_SAFE_INTEGER)) {
    return Number(value)
  }
  return value
}

/**
 * Redis glob, ported from `stringmatchlen` in Redis `util.c` so its edge cases agree: `*`, `?`,
 * `[abc]`, `[a-z]` (bounds may be reversed), `[^a]` (only `^` negates, `!` is a literal),
 * an unclosed `[` class runs to the end of the pattern, and backslash escapes.
 */
export function globMatch(pattern: string, value: string): boolean {
  // Redis short-circuits a lone `*` before matching (KEYS/SCAN), so it also matches an empty key.
  if (pattern === "*") return true
  let skipLonger = false
  const match = (pStart: number, sStart: number): boolean => {
    let p = pStart
    let s = sStart
    while (p < pattern.length && s < value.length) {
      const ch = pattern[p]
      if (ch === "*") {
        while (p + 1 < pattern.length && pattern[p + 1] === "*") p++
        if (p === pattern.length - 1) return true
        while (s < value.length) {
          if (match(p + 1, s)) return true
          // The rest of the pattern already failed against a longer tail: no later start can win.
          if (skipLonger) return false
          s++
        }
        skipLonger = true
        return false
      }
      if (ch === "[") {
        p++
        const negate = pattern[p] === "^"
        if (negate) p++
        let matched = false
        const cur = value.charCodeAt(s)
        for (;;) {
          if (pattern[p] === "\\" && p + 1 < pattern.length) {
            p++
            if (pattern.charCodeAt(p) === cur) matched = true
          } else if (pattern[p] === "]") {
            break
          } else if (p >= pattern.length) {
            p--
            break
          } else if (p + 2 < pattern.length && pattern[p + 1] === "-") {
            let start = pattern.charCodeAt(p)
            let end = pattern.charCodeAt(p + 2)
            if (start > end) [start, end] = [end, start]
            p += 2
            if (cur >= start && cur <= end) matched = true
          } else if (pattern.charCodeAt(p) === cur) matched = true
          p++
        }
        if (matched === negate) return false
        s++
      } else if (ch === "?") {
        s++
      } else {
        if (ch === "\\" && p + 1 < pattern.length) p++
        if (pattern[p] !== value[s]) return false
        s++
      }
      p++
      if (s >= value.length) {
        while (pattern[p] === "*") p++
        break
      }
    }
    return p >= pattern.length && s >= value.length
  }
  return match(0, 0)
}
