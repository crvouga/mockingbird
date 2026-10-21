/** Lua 5.1 pattern matching, a port of the matcher in lstrlib.c. */

import { rtError } from "./value.ts"

const L_ESC = 37 // "%"
const MAXCAPTURES = 32
const CAP_UNFINISHED = -1
const CAP_POSITION = -2
const MAXCCALLS = 200

export interface MatchState {
  src: string
  pat: string
  level: number
  depth: number
  capStart: number[]
  capLen: number[]
}

export function newState(src: string, pat: string): MatchState {
  return { src, pat, level: 0, depth: 0, capStart: [], capLen: [] }
}

function classEnd(ms: MatchState, p: number): number {
  const pat = ms.pat
  if (p >= pat.length) rtError("malformed pattern (ends with '%')")
  const c = pat.charCodeAt(p++)
  if (c === L_ESC) {
    if (p >= pat.length) rtError("malformed pattern (ends with '%')")
    return p + 1
  }
  if (c === 91) {
    // "["
    if (pat.charCodeAt(p) === 94) p++
    do {
      if (p >= pat.length) rtError("malformed pattern (missing ']')")
      const cc = pat.charCodeAt(p++)
      if (cc === L_ESC) p++
    } while (p >= pat.length || pat.charCodeAt(p) !== 93)
    return p + 1
  }
  return p
}

function singleClass(c: number, cl: number): boolean {
  let res: boolean
  const lower = cl | 0x20
  switch (lower) {
    case 97: // a
      res = (c >= 65 && c <= 90) || (c >= 97 && c <= 122)
      break
    case 99: // c
      res = c < 32 || c === 127
      break
    case 100: // d
      res = c >= 48 && c <= 57
      break
    case 108: // l
      res = c >= 97 && c <= 122
      break
    case 112: // p
      res =
        (c >= 33 && c <= 47) ||
        (c >= 58 && c <= 64) ||
        (c >= 91 && c <= 96) ||
        (c >= 123 && c <= 126)
      break
    case 115: // s
      res = c === 32 || (c >= 9 && c <= 13)
      break
    case 117: // u
      res = c >= 65 && c <= 90
      break
    case 119: // w
      res = (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122)
      break
    case 120: // x
      res = (c >= 48 && c <= 57) || (c >= 65 && c <= 70) || (c >= 97 && c <= 102)
      break
    case 122: // z
      res = c === 0
      break
    default:
      return cl === c
  }
  // Upper-case class letters negate; only letters reach here.
  return cl >= 65 && cl <= 90 ? !res : res
}

function matchBracketClass(ms: MatchState, c: number, p: number, ec: number): boolean {
  const pat = ms.pat
  let sig = true
  if (pat.charCodeAt(p + 1) === 94) {
    sig = false
    p++
  }
  while (++p < ec) {
    const pc = pat.charCodeAt(p)
    if (pc === L_ESC) {
      p++
      if (singleClass(c, pat.charCodeAt(p))) return sig
    } else if (pat.charCodeAt(p + 1) === 45 && p + 2 < ec) {
      p += 2
      if (pc <= c && c <= pat.charCodeAt(p)) return sig
    } else if (pc === c) return sig
  }
  return !sig
}

function singleMatch(ms: MatchState, s: number, p: number, ep: number): boolean {
  if (s >= ms.src.length) return false
  const c = ms.src.charCodeAt(s)
  const pc = ms.pat.charCodeAt(p)
  switch (pc) {
    case 46: // "."
      return true
    case L_ESC:
      return singleClass(c, ms.pat.charCodeAt(p + 1))
    case 91:
      return matchBracketClass(ms, c, p, ep - 1)
    default:
      return pc === c
  }
}

function matchBalance(ms: MatchState, s: number, p: number): number {
  if (p + 1 >= ms.pat.length) rtError("unbalanced pattern")
  if (s >= ms.src.length || ms.src.charCodeAt(s) !== ms.pat.charCodeAt(p)) return -1
  const open = ms.pat.charCodeAt(p)
  const close = ms.pat.charCodeAt(p + 1)
  let depth = 1
  while (++s < ms.src.length) {
    const c = ms.src.charCodeAt(s)
    if (c === close) {
      if (--depth === 0) return s + 1
    } else if (c === open) depth++
  }
  return -1
}

function maxExpand(ms: MatchState, s: number, p: number, ep: number): number {
  let i = 0
  while (singleMatch(ms, s + i, p, ep)) i++
  while (i >= 0) {
    const res = doMatch(ms, s + i, ep + 1)
    if (res !== -1) return res
    i--
  }
  return -1
}

function minExpand(ms: MatchState, s: number, p: number, ep: number): number {
  for (;;) {
    const res = doMatch(ms, s, ep + 1)
    if (res !== -1) return res
    if (singleMatch(ms, s, p, ep)) s++
    else return -1
  }
}

function startCapture(ms: MatchState, s: number, p: number, what: number): number {
  if (ms.level >= MAXCAPTURES) rtError("too many captures")
  ms.capStart[ms.level] = s
  ms.capLen[ms.level] = what
  ms.level++
  const res = doMatch(ms, s, p)
  if (res === -1) ms.level--
  return res
}

function endCapture(ms: MatchState, s: number, p: number): number {
  let l = -1
  for (let level = ms.level - 1; level >= 0; level--) {
    if (ms.capLen[level] === CAP_UNFINISHED) {
      l = level
      break
    }
  }
  if (l < 0) rtError("invalid pattern capture")
  ms.capLen[l] = s - (ms.capStart[l] as number)
  const res = doMatch(ms, s, p)
  if (res === -1) ms.capLen[l] = CAP_UNFINISHED
  return res
}

function checkCapture(ms: MatchState, l: number): number {
  const index = l - 49 // "1"
  if (index < 0 || index >= ms.level || ms.capLen[index] === CAP_UNFINISHED) {
    rtError("invalid capture index")
  }
  return index
}

function matchCapture(ms: MatchState, s: number, l: number): number {
  const index = checkCapture(ms, l)
  const len = ms.capLen[index] as number
  const start = ms.capStart[index] as number
  if (ms.src.length - s >= len && ms.src.substr(start, len) === ms.src.substr(s, len))
    return s + len
  return -1
}

export function doMatch(ms: MatchState, s: number, p: number): number {
  if (ms.depth++ > MAXCCALLS) rtError("pattern too complex")
  try {
    const pat = ms.pat
    for (;;) {
      if (p >= pat.length) return s
      const pc = pat.charCodeAt(p)
      if (pc === 40) {
        // "("
        if (pat.charCodeAt(p + 1) === 41) return startCapture(ms, s, p + 2, CAP_POSITION)
        return startCapture(ms, s, p + 1, CAP_UNFINISHED)
      }
      if (pc === 41) return endCapture(ms, s, p + 1)
      if (pc === 36 && p + 1 === pat.length) return s === ms.src.length ? s : -1
      if (pc === L_ESC) {
        const next = pat.charCodeAt(p + 1)
        if (next === 98) {
          // %b
          s = matchBalance(ms, s, p + 2)
          if (s === -1) return -1
          p += 4
          continue
        }
        if (next === 102) {
          // %f
          p += 2
          if (pat.charCodeAt(p) !== 91) rtError("missing '[' after '%f' in pattern")
          const ep = classEnd(ms, p)
          const prev = s === 0 ? 0 : ms.src.charCodeAt(s - 1)
          const cur = s < ms.src.length ? ms.src.charCodeAt(s) : 0
          if (!matchBracketClass(ms, prev, p, ep - 1) && matchBracketClass(ms, cur, p, ep - 1)) {
            p = ep
            continue
          }
          return -1
        }
        if (next >= 48 && next <= 57) {
          s = matchCapture(ms, s, next)
          if (s === -1) return -1
          p += 2
          continue
        }
      }
      const ep = classEnd(ms, p)
      const epc = pat.charCodeAt(ep)
      if (epc === 63) {
        // "?"
        if (singleMatch(ms, s, p, ep)) {
          const res = doMatch(ms, s + 1, ep + 1)
          if (res !== -1) return res
        }
        p = ep + 1
        continue
      }
      if (epc === 43) return singleMatch(ms, s, p, ep) ? maxExpand(ms, s + 1, p, ep) : -1
      if (epc === 42) return maxExpand(ms, s, p, ep)
      if (epc === 45) return minExpand(ms, s, p, ep)
      if (!singleMatch(ms, s, p, ep)) return -1
      s++
      p = ep
    }
  } finally {
    ms.depth--
  }
}

/** The value of capture `i` for a match of `src[s..e)`: a string, or a 1-based position. */
export function getCapture(ms: MatchState, i: number, s: number, e: number): string | number {
  if (i >= ms.level) {
    if (i === 0) return ms.src.slice(s, e)
    rtError("invalid capture index")
  }
  const len = ms.capLen[i] as number
  if (len === CAP_UNFINISHED) rtError("unfinished capture")
  const start = ms.capStart[i] as number
  if (len === CAP_POSITION) return start + 1
  return ms.src.substr(start, len)
}

/** All captures of a match, or the whole match when the pattern has none and `wholeIfNone`. */
export function getCaptures(
  ms: MatchState,
  s: number,
  e: number,
  wholeIfNone: boolean,
): Array<string | number> {
  const count = ms.level === 0 && wholeIfNone ? 1 : ms.level
  const out: Array<string | number> = []
  for (let i = 0; i < count; i++) out.push(getCapture(ms, i, s, e))
  return out
}

const SPECIALS = /[\^$*+?.()[\]%-]/

export function hasSpecials(pattern: string): boolean {
  return SPECIALS.test(pattern)
}
