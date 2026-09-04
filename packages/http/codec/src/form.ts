/**
 * Rails/PHP/Stripe-style bracket notation for `application/x-www-form-urlencoded` bodies and
 * query strings:
 *
 *   address[city]=Paris        -> { address: { city: "Paris" } }
 *   items[0][name]=a           -> { items: [{ name: "a" }] }
 *   tags[]=x&tags[]=y          -> { tags: ["x", "y"] }
 *   metadata[k]=v              -> { metadata: { k: "v" } }
 *
 * Decoding yields only strings, arrays and plain objects — coercion is the caller's concern,
 * exactly like a real HTTP server.
 */

export type FormValue = string | FormValue[] | { [key: string]: FormValue }

export type FormObject = { [key: string]: FormValue }

const encodeComponent = (value: string) =>
  encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  )

const flatten = (prefix: string, value: unknown, out: Array<[string, string]>) => {
  if (value === undefined) return
  if (value === null) {
    out.push([prefix, ""])
    return
  }
  if (Array.isArray(value)) {
    if (value.length === 0) {
      out.push([prefix, ""])
      return
    }
    value.forEach((item, index) => {
      flatten(`${prefix}[${index}]`, item, out)
    })
    return
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
    if (entries.length === 0) {
      out.push([prefix, ""])
      return
    }
    for (const [key, item] of entries) flatten(`${prefix}[${key}]`, item, out)
    return
  }
  out.push([prefix, String(value)])
}

/**
 * Encode a JSON-like value as bracket-notation pairs. Nested arrays use explicit indices
 * (`a[0]`), which every bracket parser (including Stripe's) accepts; empty arrays/objects
 * encode as an empty string, matching how Stripe unsets fields.
 */
export const encodeFormPairs = (value: Record<string, unknown>): Array<[string, string]> => {
  const out: Array<[string, string]> = []
  for (const [key, item] of Object.entries(value)) flatten(key, item, out)
  return out
}

/** Encode to a full `application/x-www-form-urlencoded` string. */
export const encodeForm = (value: Record<string, unknown>): string =>
  encodeFormPairs(value)
    .map(([k, v]) => `${encodeComponent(k)}=${encodeComponent(v)}`)
    .join("&")

const parsePath = (rawKey: string): string[] => {
  const open = rawKey.indexOf("[")
  if (open === -1) return [rawKey]
  const path = [rawKey.slice(0, open)]
  const rest = rawKey.slice(open)
  const pattern = /\[([^\]]*)\]/g
  let match: RegExpExecArray | null = pattern.exec(rest)
  let consumed = 0
  while (match !== null) {
    if (match.index !== consumed) return [rawKey]
    path.push(match[1] ?? "")
    consumed = match.index + match[0].length
    match = pattern.exec(rest)
  }
  if (consumed !== rest.length) return [rawKey]
  return path
}

const isIndex = (segment: string) => /^(0|[1-9][0-9]*)$/.test(segment)

const assign = (target: FormObject, path: string[], value: string) => {
  let cursor: FormValue = target
  for (let i = 0; i < path.length; i++) {
    const segment = path[i] as string
    const last = i === path.length - 1
    if (Array.isArray(cursor)) {
      const index: number | undefined =
        segment === "" ? cursor.length : isIndex(segment) ? Number(segment) : undefined
      if (index === undefined) return
      if (last) {
        cursor[index] = value
        return
      }
      const next: FormValue | undefined = cursor[index]
      if (next === undefined || typeof next === "string") {
        const created: FormValue = path[i + 1] === "" || isIndex(path[i + 1] as string) ? [] : {}
        cursor[index] = created
        cursor = created
      } else {
        cursor = next
      }
      continue
    }
    if (typeof cursor === "string") return
    if (last) {
      cursor[segment] = value
      return
    }
    const nextSegment = path[i + 1] as string
    const existing: FormValue | undefined = cursor[segment]
    if (existing === undefined || typeof existing === "string") {
      const created: FormValue = nextSegment === "" || isIndex(nextSegment) ? [] : {}
      cursor[segment] = created
      cursor = created
    } else {
      cursor = existing
    }
  }
}

/** Decode `key=value&...` pairs (already percent-decoded) into a nested object. */
export const decodeFormPairs = (pairs: Iterable<[string, string]>): FormObject => {
  const out: FormObject = {}
  for (const [rawKey, value] of pairs) assign(out, parsePath(rawKey), value)
  return densify(out) as FormObject
}

/** Sparse arrays (`a[2]=x` without `a[0]`) become dense in bracket parsers. */
const densify = (value: FormValue): FormValue => {
  if (typeof value === "string") return value
  if (Array.isArray(value)) return value.filter((item) => item !== undefined).map(densify)
  const out: FormObject = {}
  for (const [key, item] of Object.entries(value)) out[key] = densify(item)
  return out
}

/** Decode an `application/x-www-form-urlencoded` body or a query string (with or without `?`). */
export const decodeForm = (text: string): FormObject => {
  const source = text.startsWith("?") ? text.slice(1) : text
  return decodeFormPairs(new URLSearchParams(source).entries())
}
