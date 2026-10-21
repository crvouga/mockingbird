/** C `printf` number formatting (`%d %x %e %f %g`) with exact rounding, as Lua's `string.format` does. */

const f64 = new Float64Array(1)
const u64 = new BigUint64Array(f64.buffer)

/** Exact decimal expansion of a finite, non-negative double: `digits` x 10^-`scale`. */
function exactDecimal(x: number): { digits: string; scale: number } {
  f64[0] = x
  const bits = u64[0] as bigint
  const exponent = Number((bits >> 52n) & 0x7ffn)
  const fraction = bits & 0xfffffffffffffn
  const mantissa = exponent === 0 ? fraction : fraction | 0x10000000000000n
  const power = (exponent === 0 ? 1 : exponent) - 1075
  if (power >= 0) return { digits: (mantissa << BigInt(power)).toString(), scale: 0 }
  return { digits: (mantissa * 5n ** BigInt(-power)).toString(), scale: -power }
}

/** Drop `drop` trailing digits, rounding half to even on the exact value. */
function roundDrop(digits: string, drop: number): string {
  if (drop <= 0) return digits + "0".repeat(-drop)
  const kept = digits.length > drop ? digits.slice(0, digits.length - drop) : ""
  const dropped =
    digits.length >= drop ? digits.slice(digits.length - drop) : digits.padStart(drop, "0")
  let value = BigInt(kept === "" ? "0" : kept)
  const head = dropped.charCodeAt(0) - 48
  const rest = /[1-9]/.test(dropped.slice(1))
  if (head > 5 || (head === 5 && (rest || value % 2n === 1n))) value += 1n
  return value.toString()
}

function nonFinite(x: number, upper: boolean): string | null {
  if (Number.isNaN(x)) return upper ? "NAN" : "nan"
  if (x === Infinity) return upper ? "INF" : "inf"
  if (x === -Infinity) return upper ? "-INF" : "-inf"
  return null
}

const isNegative = (x: number) => x < 0 || Object.is(x, -0)

/** `%.{precision}f` of a finite non-negative number. */
function fixedDigits(x: number, precision: number): string {
  if (Number.isInteger(x) && x < 2 ** 53) {
    return precision === 0 ? String(x) : `${x}.${"0".repeat(precision)}`
  }
  const { digits, scale } = exactDecimal(x)
  const rounded = roundDrop(digits, scale - precision).padStart(precision + 1, "0")
  return precision === 0
    ? rounded
    : `${rounded.slice(0, rounded.length - precision)}.${rounded.slice(rounded.length - precision)}`
}

/** `{ digits, exp }`: `precision` + 1 significant digits and the decimal exponent of a positive number. */
function expDigits(x: number, precision: number): { digits: string; exp: number } {
  if (x === 0) return { digits: "0".repeat(precision + 1), exp: 0 }
  const { digits, scale } = exactDecimal(x)
  const trimmed = digits.replace(/^0+/, "")
  let exp = trimmed.length - scale - 1
  let rounded = roundDrop(trimmed, trimmed.length - (precision + 1))
  if (rounded.length > precision + 1) {
    rounded = rounded.slice(0, precision + 1)
    exp++
  }
  return { digits: rounded, exp }
}

function expText(exp: number): string {
  const magnitude = Math.abs(exp)
  return `${exp < 0 ? "-" : "+"}${magnitude < 10 ? "0" : ""}${magnitude}`
}

function trimZeros(text: string): string {
  return text.includes(".") ? text.replace(/\.?0+$/, "") : text
}

export interface NumberSpec {
  conv: string
  flags: string
  width: number
  precision: number | null
}

function pad(body: string, sign: string, spec: NumberSpec, zeroOk: boolean): string {
  const length = sign.length + body.length
  if (spec.width <= length) return sign + body
  if (spec.flags.includes("-")) return sign + body + " ".repeat(spec.width - length)
  if (zeroOk && spec.flags.includes("0")) return sign + "0".repeat(spec.width - length) + body
  return " ".repeat(spec.width - length) + sign + body
}

/** Format a double with `%e %E %f %g %G`. */
export function formatFloat(x: number, spec: NumberSpec): string {
  const upper = spec.conv === "E" || spec.conv === "G"
  const special = nonFinite(x, upper)
  const negative = isNegative(x)
  const sign = negative ? "-" : spec.flags.includes("+") ? "+" : spec.flags.includes(" ") ? " " : ""
  if (special !== null) {
    return pad(special.replace("-", ""), special.startsWith("-") ? "-" : sign, spec, false)
  }
  const magnitude = Math.abs(x)
  const alt = spec.flags.includes("#")
  let body: string
  const conv = spec.conv.toLowerCase()
  if (conv === "f") {
    body = fixedDigits(magnitude, spec.precision ?? 6)
    if (alt && !body.includes(".")) body += "."
  } else if (conv === "e") {
    const precision = spec.precision ?? 6
    const { digits, exp } = expDigits(magnitude, precision)
    const mantissa = precision === 0 ? digits : `${digits[0]}.${digits.slice(1)}`
    body = `${mantissa}${alt && precision === 0 ? "." : ""}e${expText(exp)}`
    if (upper) body = body.toUpperCase()
  } else {
    const precision = spec.precision === null ? 6 : spec.precision === 0 ? 1 : spec.precision
    const { digits, exp } = expDigits(magnitude, precision - 1)
    if (exp < -4 || exp >= precision) {
      let mantissa = precision === 1 ? digits : `${digits[0]}.${digits.slice(1)}`
      if (!alt) mantissa = trimZeros(mantissa)
      body = `${mantissa}e${expText(exp)}`
    } else {
      body = fixedDigits(magnitude, Math.max(0, precision - 1 - exp))
      if (!alt) body = trimZeros(body)
    }
    if (upper) body = body.toUpperCase()
  }
  return pad(body, sign, spec, true)
}

const INT64_MAX = 9223372036854775807n
const INT64_MIN = -9223372036854775808n

/** C's `(long long) x` for a Lua number: truncates, saturates, and maps NaN to 0. */
export function toInt64(x: number): bigint {
  if (Number.isNaN(x)) return 0n
  if (x >= 2 ** 63) return INT64_MAX
  if (x <= -(2 ** 63)) return INT64_MIN
  return BigInt(Math.trunc(x))
}

/** Format an integer with `%d %i %u %o %x %X`. */
export function formatInteger(x: number, spec: NumberSpec): string {
  let value = toInt64(x)
  const signed = spec.conv === "d" || spec.conv === "i"
  let sign = ""
  if (signed) {
    if (value < 0n) {
      sign = "-"
      value = -value
    } else if (spec.flags.includes("+")) sign = "+"
    else if (spec.flags.includes(" ")) sign = " "
  } else value = BigInt.asUintN(64, value)
  const radix = spec.conv === "o" ? 8 : spec.conv === "x" || spec.conv === "X" ? 16 : 10
  let digits = value.toString(radix)
  if (spec.conv === "X") digits = digits.toUpperCase()
  if (spec.precision !== null) {
    if (spec.precision === 0 && value === 0n) digits = ""
    digits = digits.padStart(spec.precision, "0")
  }
  if (spec.flags.includes("#")) {
    if (spec.conv === "o" && !digits.startsWith("0")) digits = `0${digits}`
    else if ((spec.conv === "x" || spec.conv === "X") && value !== 0n) {
      sign = spec.conv === "x" ? "0x" : "0X"
    }
  }
  return pad(digits, sign, spec, spec.precision === null)
}

/** `%.14g`, the way Lua prints a number. */
export function numberToString(x: number): string {
  if (Number.isInteger(x) && Math.abs(x) < 1e14) return Object.is(x, -0) ? "-0" : String(x)
  if (!Number.isFinite(x)) return nonFinite(x, false) as string
  const shortest = x.toExponential()
  const mantissaDigits = shortest.indexOf("e") - (x < 0 ? 1 : 0) - (shortest.includes(".") ? 1 : 0)
  if (mantissaDigits <= 14) {
    const exp = Number(shortest.slice(shortest.indexOf("e") + 1))
    if (exp >= -4 && exp < 14) return String(x)
  }
  return formatFloat(x, { conv: "g", flags: "", width: 0, precision: 14 })
}
