import type { JsonPath } from "@crvouga/mockingbird-openapi-metadata"

export type Difference =
  | { kind: "type"; path: JsonPath; left: string; right: string }
  | { kind: "value"; path: JsonPath; left: unknown; right: unknown }
  | { kind: "length"; path: JsonPath; left: number; right: number }
  | { kind: "missing-left"; path: JsonPath; right: unknown }
  | { kind: "missing-right"; path: JsonPath; left: unknown }

const kindOf = (value: unknown): string => {
  if (value === null) return "null"
  if (Array.isArray(value)) return "array"
  if (value instanceof Uint8Array) return "bytes"
  return typeof value
}

/**
 * Strict structural diff. Key order is irrelevant for objects; element order is significant for
 * arrays; `undefined` properties count as omitted; `-0`/`+0` and NaN compare via `Object.is`.
 */
export const structuralDiff = (
  left: unknown,
  right: unknown,
  path: JsonPath = [],
  out: Difference[] = [],
): Difference[] => {
  const leftKind = kindOf(left)
  const rightKind = kindOf(right)
  if (leftKind !== rightKind) {
    out.push({ kind: "type", path, left: leftKind, right: rightKind })
    return out
  }
  if (leftKind === "array") {
    const l = left as unknown[]
    const r = right as unknown[]
    if (l.length !== r.length) out.push({ kind: "length", path, left: l.length, right: r.length })
    const n = Math.min(l.length, r.length)
    for (let i = 0; i < n; i++) structuralDiff(l[i], r[i], [...path, i], out)
    return out
  }
  if (leftKind === "bytes") {
    const l = left as Uint8Array
    const r = right as Uint8Array
    if (l.byteLength !== r.byteLength || l.some((byte, i) => byte !== r[i])) {
      out.push({
        kind: "value",
        path,
        left: `<${l.byteLength} bytes>`,
        right: `<${r.byteLength} bytes>`,
      })
    }
    return out
  }
  if (leftKind === "object") {
    const l = left as Record<string, unknown>
    const r = right as Record<string, unknown>
    const keys = [...new Set([...Object.keys(l), ...Object.keys(r)])].sort()
    for (const key of keys) {
      const inLeft = key in l && l[key] !== undefined
      const inRight = key in r && r[key] !== undefined
      if (inLeft && !inRight)
        out.push({ kind: "missing-right", path: [...path, key], left: l[key] })
      else if (!inLeft && inRight)
        out.push({ kind: "missing-left", path: [...path, key], right: r[key] })
      else if (inLeft && inRight) structuralDiff(l[key], r[key], [...path, key], out)
    }
    return out
  }
  if (!Object.is(left, right)) out.push({ kind: "value", path, left, right })
  return out
}

export const formatPath = (path: JsonPath) =>
  path.length === 0
    ? "$"
    : `$${path.map((p) => (typeof p === "number" ? `[${p}]` : `.${p}`)).join("")}`

const show = (value: unknown) => {
  const text = JSON.stringify(value)
  return text === undefined ? String(value) : text.length > 200 ? `${text.slice(0, 200)}…` : text
}

export const formatDifference = (
  difference: Difference,
  labels: [string, string] = ["real", "mock"],
): string => {
  const at = formatPath(difference.path)
  switch (difference.kind) {
    case "type":
      return `${at}: type ${labels[0]}=${difference.left} ${labels[1]}=${difference.right}`
    case "value":
      return `${at}: ${labels[0]}=${show(difference.left)} ${labels[1]}=${show(difference.right)}`
    case "length":
      return `${at}: length ${labels[0]}=${difference.left} ${labels[1]}=${difference.right}`
    case "missing-left":
      return `${at}: only in ${labels[1]}: ${show(difference.right)}`
    case "missing-right":
      return `${at}: only in ${labels[0]}: ${show(difference.left)}`
  }
}
