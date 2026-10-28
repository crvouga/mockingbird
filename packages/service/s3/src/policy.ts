/**
 * Bucket policies and authorization, as MinIO does them (`github.com/minio/pkg/v3/policy`).
 *
 * - The owner (any configured access key) may do anything.
 * - An anonymous request (strict mode) is allowed only where the bucket policy grants the
 *   operation's action to `*`: every Deny statement that matches refuses, then any matching Allow
 *   permits. A bucket without a policy (or that does not exist) refuses everything.
 *
 * `parseBucketPolicy` reproduces `policy.ParseBucketPolicyConfig` (Go `encoding/json` decoding
 * with its error messages, then `Validate(bucket)`), and `marshalBucketPolicy` the document
 * GetBucketPolicy answers. Go marshals action/resource sets in map order; this marshals them
 * sorted.
 */
import type { Ctx } from "./context.js"
import { fail, S3Error } from "./errors.js"
import type { Operation } from "./router.js"
import type { S3Core } from "./store.js"

// ── Go encoding/json, as much as a policy document needs ─────────────────────────────────

type J =
  | { t: "null" }
  | { t: "bool"; v: boolean }
  | { t: "number"; v: string }
  | { t: "string"; v: string }
  | { t: "array"; v: J[] }
  | { t: "object"; v: [string, J][] }

/** A policy error: MinIO answers `MalformedPolicy` with this message. */
export class PolicyError extends Error {}

const quoteChar = (char: string) => {
  if (char === "'") return "'\\''"
  if (char === '"') return "'\"'"
  const quoted = JSON.stringify(char).slice(1, -1)
  return `'${quoted}'`
}

/** Go's `json.Decoder.Decode` of the first value in `text` (trailing data is ignored). */
const decodeJson = (text: string): J => {
  let pos = 0
  const eof = () => new PolicyError("unexpected EOF")
  const skip = () => {
    while (pos < text.length && " \t\r\n".includes(text.charAt(pos))) pos++
  }
  const invalid = (context: string) => {
    if (pos >= text.length) return eof()
    return new PolicyError(`invalid character ${quoteChar(text.charAt(pos))} ${context}`)
  }
  const literal = (word: string, value: J): J => {
    for (let index = 1; index < word.length; index++) {
      pos++
      if (pos >= text.length) throw eof()
      if (text.charAt(pos) !== word.charAt(index))
        throw invalid(`in literal ${word} (expecting ${quoteChar(word.charAt(index))})`)
    }
    pos++
    return value
  }
  const string = (): string => {
    pos++
    let out = ""
    for (;;) {
      if (pos >= text.length) throw eof()
      const char = text.charAt(pos)
      if (char === '"') {
        pos++
        return out
      }
      if (char < " ") throw invalid("in string literal")
      if (char === "\\") {
        pos++
        if (pos >= text.length) throw eof()
        const code = text.charAt(pos)
        const simple: Record<string, string> = {
          '"': '"',
          "\\": "\\",
          "/": "/",
          b: "\b",
          f: "\f",
          n: "\n",
          r: "\r",
          t: "\t",
        }
        if (code in simple) {
          out += simple[code]
          pos++
          continue
        }
        if (code !== "u") throw invalid("in string escape code")
        let hex = ""
        for (let index = 0; index < 4; index++) {
          pos++
          if (pos >= text.length) throw eof()
          if (!/[0-9a-fA-F]/.test(text.charAt(pos)))
            throw invalid("in \\u hexadecimal character escape")
          hex += text.charAt(pos)
        }
        out += String.fromCharCode(Number.parseInt(hex, 16))
        pos++
        continue
      }
      out += char
      pos++
    }
  }
  const number = (): J => {
    const start = pos
    if (text.charAt(pos) === "-") {
      pos++
      if (pos >= text.length) throw eof()
      if (!/[0-9]/.test(text.charAt(pos))) throw invalid("in numeric literal")
    }
    if (text.charAt(pos) === "0") pos++
    else while (/[0-9]/.test(text.charAt(pos))) pos++
    if (text.charAt(pos) === ".") {
      pos++
      if (pos >= text.length) throw eof()
      if (!/[0-9]/.test(text.charAt(pos))) throw invalid("after decimal point in numeric literal")
      while (/[0-9]/.test(text.charAt(pos))) pos++
    }
    if (/[eE]/.test(text.charAt(pos))) {
      pos++
      if (/[+-]/.test(text.charAt(pos))) pos++
      if (pos >= text.length) throw eof()
      if (!/[0-9]/.test(text.charAt(pos))) throw invalid("in exponent of numeric literal")
      while (/[0-9]/.test(text.charAt(pos))) pos++
    }
    return { t: "number", v: text.slice(start, pos) }
  }
  const value = (): J => {
    skip()
    if (pos >= text.length) throw eof()
    const char = text.charAt(pos)
    if (char === "{") {
      pos++
      const entries: [string, J][] = []
      skip()
      if (text.charAt(pos) === "}") {
        pos++
        return { t: "object", v: entries }
      }
      for (;;) {
        skip()
        if (pos >= text.length) throw eof()
        if (text.charAt(pos) !== '"') throw invalid("looking for beginning of object key string")
        const key = string()
        skip()
        if (pos >= text.length) throw eof()
        if (text.charAt(pos) !== ":") throw invalid("after object key")
        pos++
        entries.push([key, value()])
        skip()
        if (pos >= text.length) throw eof()
        if (text.charAt(pos) === ",") {
          pos++
          continue
        }
        if (text.charAt(pos) === "}") {
          pos++
          return { t: "object", v: entries }
        }
        throw invalid("after object key:value pair")
      }
    }
    if (char === "[") {
      pos++
      const items: J[] = []
      skip()
      if (text.charAt(pos) === "]") {
        pos++
        return { t: "array", v: items }
      }
      for (;;) {
        items.push(value())
        skip()
        if (pos >= text.length) throw eof()
        if (text.charAt(pos) === ",") {
          pos++
          continue
        }
        if (text.charAt(pos) === "]") {
          pos++
          return { t: "array", v: items }
        }
        throw invalid("after array element")
      }
    }
    if (char === '"') return { t: "string", v: string() }
    if (char === "-" || /[0-9]/.test(char)) return number()
    if (char === "t") return literal("true", { t: "bool", v: true })
    if (char === "f") return literal("false", { t: "bool", v: false })
    if (char === "n") return literal("null", { t: "null" })
    throw invalid("looking for beginning of value")
  }
  skip()
  if (pos >= text.length) throw new PolicyError("EOF")
  return value()
}

const kindName = (value: J) => (value.t === "bool" ? "bool" : value.t)

/** `fmt.Sprintf("%v", x)` of a decoded `interface{}`. */
const goFormat = (value: J): string => {
  switch (value.t) {
    case "null":
      return "<nil>"
    case "bool":
      return String(value.v)
    case "number": {
      const n = Number(value.v)
      if (Number.isInteger(n) && Math.abs(n) < 1e21) return String(n)
      const exp = n.toExponential()
      const [mantissa, power = "0"] = exp.split("e")
      const p = Number(power)
      if (p < -4 || p >= 21)
        return `${mantissa}e${p < 0 ? "-" : "+"}${String(Math.abs(p)).padStart(2, "0")}`
      return String(n)
    }
    case "string":
      return value.v
    case "array":
      return `[${value.v.map(goFormat).join(" ")}]`
    case "object":
      return `map[${[...value.v]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, item]) => `${key}:${goFormat(item)}`)
        .join(" ")}]`
  }
}

/** Go matches JSON keys to struct fields exactly first, then case-insensitively; last wins. */
const fields = (object: [string, J][], names: readonly string[]) => {
  const out: Record<string, J> = {}
  for (const [key, value] of object) {
    const name =
      names.find((candidate) => candidate === key) ??
      names.find((candidate) => candidate.toLowerCase() === key.toLowerCase())
    if (name) out[name] = value
  }
  return out
}

/** `set.StringSet` UnmarshalJSON: an array (each `%v`-formatted) or a single value. */
const stringSet = (value: J): string[] => {
  const items = value.t === "array" ? value.v.map(goFormat) : [goFormat(value)]
  return [...new Set(items)].sort()
}

// ── the policy model ─────────────────────────────────────────────────────────────────────

const ARN_S3 = "arn:aws:s3:::"
const ARN_KMS = "arn:minio:kms:::"

type ResourceType = "s3" | "kms" | "all"
type Resource = { pattern: string; type: ResourceType }

type ConditionValue =
  | { kind: "string"; v: string }
  | { kind: "int"; v: number }
  | { kind: "bool"; v: boolean }

type ConditionFn = {
  /** Operator as written, e.g. `StringEquals` or `ForAnyValue:StringLike`. */
  name: string
  qualifier: string
  op: string
  /** The condition key, e.g. `s3:prefix` (with a `/variable` suffix for tag keys). */
  key: string
  values: ConditionValue[]
}

export type Statement = {
  sid: string
  effect: string
  principals: string[]
  actions: string[]
  notActions: string[]
  resources: Resource[]
  notResources: Resource[]
  conditions: ConditionFn[]
}

export type BucketPolicy = {
  id: string
  version: string
  statements: Statement[]
  /** `Statement` was absent or null (Go marshals the nil slice as `null`). */
  nilStatements?: boolean
}

const resourceString = (resource: Resource) =>
  (resource.type === "s3" ? ARN_S3 : resource.type === "kms" ? ARN_KMS : "*") + resource.pattern

const parseResource = (value: string): Resource => {
  let resource: Resource | undefined
  if (value === "*") resource = { type: "all", pattern: "*" }
  else if (value.startsWith(ARN_S3)) resource = { type: "s3", pattern: value.slice(ARN_S3.length) }
  else if (value.startsWith(ARN_KMS))
    resource = { type: "kms", pattern: value.slice(ARN_KMS.length) }
  else if (value.startsWith("*")) resource = { type: "all", pattern: value.slice(1) }
  if (!resource) throw new PolicyError(`invalid resource '${value}'`)
  if (resource.pattern.startsWith("/"))
    throw new PolicyError(`invalid resource '${value}' - starts with '/' will not match a bucket`)
  return resource
}

const resourceIsValid = (resource: Resource) => {
  if (resource.type === "s3" || resource.type === "all")
    if (resource.pattern.startsWith("/")) return false
  if (resource.type === "kms" || resource.type === "all")
    if (/[/\\.]/.test(resource.pattern)) return false
  return resource.pattern !== ""
}

/** `wildcard.Match` (`*` any run, `?` exactly one character). */
export const wildcardMatch = (pattern: string, name: string, simple = false): boolean => {
  if (pattern === "") return name === pattern
  if (pattern === "*") return true
  const deep = (str: string, pat: string): boolean => {
    let s = str
    let p = pat
    while (p.length > 0) {
      const head = p.charAt(0)
      if (head === "*")
        return p.length === 1 || deep(s, p.slice(1)) || (s.length > 0 && deep(s.slice(1), p))
      if (head === "?") {
        if (s.length === 0) return simple
      } else if (s.length === 0 || s.charAt(0) !== head) return false
      s = s.slice(1)
      p = p.slice(1)
    }
    return s.length === 0 && p.length === 0
  }
  return deep(name, pattern)
}

const matchAsPatternPrefix = (pattern: string, text: string) => {
  for (let index = 0; index < text.length && index < pattern.length; index++) {
    if (pattern.charAt(index) === "*") return true
    if (pattern.charAt(index) === "?") continue
    if (pattern.charAt(index) !== text.charAt(index)) return false
  }
  return text.length <= pattern.length
}

const OBJECT_ACTIONS = [
  "s3:*",
  "s3:AbortMultipartUpload",
  "s3:DeleteObject",
  "s3:GetObject",
  "s3:ListMultipartUploadParts",
  "s3:PutObject",
  "s3:BypassGovernanceRetention",
  "s3:PutObjectRetention",
  "s3:GetObjectRetention",
  "s3:PutObjectLegalHold",
  "s3:GetObjectLegalHold",
  "s3:GetObjectTagging",
  "s3:PutObjectTagging",
  "s3:DeleteObjectTagging",
  "s3:GetObjectVersion",
  "s3:GetObjectVersionTagging",
  "s3:DeleteObjectVersion",
  "s3:DeleteObjectVersionTagging",
  "s3:PutObjectVersionTagging",
  "s3:ReplicateObject",
  "s3:ReplicateDelete",
  "s3:ReplicateTags",
  "s3:GetObjectVersionForReplication",
  "s3:RestoreObject",
  "s3:ResetBucketReplicationState",
  "s3:PutObjectFanOut",
  "s3:GetObjectAttributes",
  "s3:GetObjectVersionAttributes",
]
const isObjectAction = (action: string) =>
  OBJECT_ACTIONS.some((known) => wildcardMatch(action, known))

// Condition keys (`condition.AllSupportedKeys`, `CommonKeys`) and which actions accept which.
const COMMON_KEYS = [
  "s3:signatureversion",
  "s3:authType",
  "s3:signatureAge",
  "s3:x-amz-content-sha256",
  "s3:LocationConstraint",
  "aws:Referer",
  "aws:SourceIp",
  "aws:UserAgent",
  "aws:SecureTransport",
  "aws:CurrentTime",
  "aws:EpochTime",
  "aws:principaltype",
  "aws:userid",
  "aws:username",
  "aws:groups",
  "ldap:user",
  "ldap:username",
  "ldap:groups",
  ...[
    "sub",
    "iss",
    "aud",
    "jti",
    "upn",
    "name",
    "groups",
    "given_name",
    "family_name",
    "middle_name",
    "nickname",
    "preferred_username",
    "profile",
    "picture",
    "website",
    "email",
    "gender",
    "birthdate",
    "phone_number",
    "address",
    "scope",
    "client_id",
  ].map((name) => `jwt:${name}`),
]
const ALL_KEYS = [
  ...COMMON_KEYS,
  "s3:x-amz-copy-source",
  "s3:x-amz-server-side-encryption",
  "s3:x-amz-server-side-encryption-customer-algorithm",
  "s3:x-amz-metadata-directive",
  "s3:x-amz-storage-class",
  "s3:x-amz-server-side-encryption-aws-kms-key-id",
  "s3:prefix",
  "s3:delimiter",
  "s3:max-keys",
  "s3:versionid",
  "s3:object-lock-remaining-retention-days",
  "s3:object-lock-mode",
  "s3:object-lock-legal-hold",
  "s3:object-lock-retain-until-date",
  "s3:RequestObjectTag",
  "s3:ExistingObjectTag",
  "s3:RequestObjectTagKeys",
  "sts:DurationSeconds",
  "svc:DurationSeconds",
]
const SSE = [
  "s3:x-amz-server-side-encryption",
  "s3:x-amz-server-side-encryption-customer-algorithm",
  "s3:x-amz-server-side-encryption-aws-kms-key-id",
]
const VERSION_TAG = ["s3:versionid", "s3:ExistingObjectTag"]
const LIST = ["s3:prefix", "s3:delimiter", "s3:max-keys"]
const REQUEST_TAGS = ["s3:RequestObjectTagKeys", "s3:RequestObjectTag"]
const ACTION_KEYS: Record<string, string[]> = {
  "s3:*": ALL_KEYS,
  "s3:DeleteObject": ["s3:versionid"],
  "s3:GetObject": [...SSE, ...VERSION_TAG],
  "s3:GetObjectAttributes": ["s3:ExistingObjectTag"],
  "s3:GetObjectVersionAttributes": VERSION_TAG,
  "s3:ListBucket": LIST,
  "s3:ListBucketVersions": LIST,
  "s3:PutObject": [
    "s3:x-amz-copy-source",
    ...SSE,
    "s3:x-amz-metadata-directive",
    "s3:x-amz-storage-class",
    "s3:versionid",
    "s3:object-lock-retain-until-date",
    "s3:object-lock-mode",
    "s3:object-lock-legal-hold",
    ...REQUEST_TAGS,
  ],
  "s3:PutObjectRetention": [
    ...SSE,
    "s3:object-lock-remaining-retention-days",
    "s3:object-lock-retain-until-date",
    "s3:object-lock-mode",
    "s3:versionid",
  ],
  "s3:GetObjectRetention": [...SSE, "s3:versionid"],
  "s3:PutObjectLegalHold": [...SSE, "s3:object-lock-legal-hold", "s3:versionid"],
  "s3:BypassGovernanceRetention": [
    "s3:versionid",
    "s3:object-lock-remaining-retention-days",
    "s3:object-lock-retain-until-date",
    "s3:object-lock-mode",
    "s3:object-lock-legal-hold",
    ...REQUEST_TAGS,
  ],
  "s3:PutBucketTagging": REQUEST_TAGS,
  "s3:PutObjectTagging": [...VERSION_TAG, ...REQUEST_TAGS],
  "s3:GetObjectTagging": VERSION_TAG,
  "s3:DeleteObjectTagging": VERSION_TAG,
  "s3:PutObjectVersionTagging": [...VERSION_TAG, ...REQUEST_TAGS],
  "s3:GetObjectVersion": VERSION_TAG,
  "s3:GetObjectVersionTagging": VERSION_TAG,
  "s3:DeleteObjectVersion": ["s3:versionid"],
  "s3:DeleteObjectVersionTagging": VERSION_TAG,
  "s3:ReplicateObject": VERSION_TAG,
  "s3:ReplicateDelete": VERSION_TAG,
  "s3:ReplicateTags": VERSION_TAG,
  "s3:GetObjectVersionForReplication": VERSION_TAG,
}
/** `IAMActionConditionKeyMap.Lookup`: common keys plus those of every map action it matches. */
const keysFor = (action: string) => {
  const keys = new Set(COMMON_KEYS)
  for (const [known, extra] of Object.entries(ACTION_KEYS))
    if (wildcardMatch(action, known)) for (const key of extra) keys.add(key)
  return keys
}

const CONDITION_NAMES = [
  "StringEquals",
  "StringNotEquals",
  "StringEqualsIgnoreCase",
  "StringNotEqualsIgnoreCase",
  "StringLike",
  "StringNotLike",
  "BinaryEquals",
  "IpAddress",
  "NotIpAddress",
  "Null",
  "Bool",
  "NumericEquals",
  "NumericNotEquals",
  "NumericLessThan",
  "NumericLessThanEquals",
  "NumericGreaterThan",
  "NumericGreaterThanIfExists",
  "NumericGreaterThanEquals",
  "DateEquals",
  "DateNotEquals",
  "DateLessThan",
  "DateLessThanEquals",
  "DateGreaterThan",
  "DateGreaterThanEquals",
]

const valueString = (value: ConditionValue) => String(value.v)

/** `condition.Value` UnmarshalJSON: bool, then int, then string. */
const conditionValue = (value: J): ConditionValue => {
  if (value.t === "bool") return { kind: "bool", v: value.v }
  if (value.t === "number" && /^-?\d+$/.test(value.v) && Math.abs(Number(value.v)) < 2 ** 63)
    return { kind: "int", v: Number(value.v) }
  if (value.t === "string") return { kind: "string", v: value.v }
  throw new PolicyError(`unknown json data '${goBytes(jsonSource(value))}'`)
}
const jsonSource = (value: J): string => {
  switch (value.t) {
    case "null":
      return "null"
    case "bool":
      return String(value.v)
    case "number":
      return value.v
    case "string":
      return JSON.stringify(value.v)
    case "array":
      return `[${value.v.map(jsonSource).join(",")}]`
    case "object":
      return `{${value.v.map(([key, item]) => `${JSON.stringify(key)}:${jsonSource(item)}`).join(",")}}`
  }
}
const goBytes = (text: string) => `[${[...new TextEncoder().encode(text)].join(" ")}]`

const ipv4 = (value: string): number[] | undefined => {
  const parts = value.split(".")
  if (parts.length !== 4) return undefined
  const bytes = parts.map((part) => (/^\d{1,3}$/.test(part) ? Number(part) : Number.NaN))
  return bytes.every((byte) => byte >= 0 && byte <= 255) ? bytes : undefined
}
/** The 32-bit value of four address bytes. */
const ipValue = (bytes: number[]) => bytes.reduce((total, byte) => total * 256 + byte, 0)
const parseCidr = (value: string) => {
  const [address = "", bits = ""] = value.split("/")
  const bytes = ipv4(address)
  const prefix = /^\d+$/.test(bits) ? Number(bits) : Number.NaN
  if (!bytes || !(prefix >= 0 && prefix <= 32)) return undefined
  const mask = prefix === 0 ? 0 : (~0 << (32 - prefix)) >>> 0
  const network = ipValue(bytes) & mask
  return { network: network >>> 0, mask, prefix }
}
const cidrString = (cidr: { network: number; prefix: number }) =>
  `${[24, 16, 8, 0].map((shift) => (cidr.network >>> shift) & 255).join(".")}/${cidr.prefix}`

const conditionFunctions = (value: J): ConditionFn[] => {
  if (value.t !== "object")
    throw new PolicyError(
      `json: cannot unmarshal ${kindName(value)} into Go value of type map[string]map[string]condition.ValueSet`,
    )
  // Go decodes into a map: the last duplicate name wins.
  const byName = new Map<string, J>()
  for (const [name, args] of value.v) byName.set(name, args)
  if (byName.size === 0) throw new PolicyError("condition must not be empty")
  const out: ConditionFn[] = []
  for (const [fullName, args] of byName) {
    const tokens = fullName.split(":")
    if (tokens.length > 2) throw new PolicyError(`invalid condition name '${fullName}'`)
    const [qualifier, op] = tokens.length === 2 ? (tokens as [string, string]) : ["", fullName]
    if (
      !CONDITION_NAMES.includes(op) ||
      (qualifier && qualifier !== "ForAllValues" && qualifier !== "ForAnyValue")
    )
      throw new PolicyError(`invalid condition name '${fullName}'`)
    if (args.t !== "object")
      throw new PolicyError(
        `json: cannot unmarshal ${kindName(args)} into Go value of type map[string]condition.ValueSet`,
      )
    const byKey = new Map<string, J>()
    for (const [key, raw] of args.v) byKey.set(key, raw)
    for (const [key, raw] of byKey) {
      const keyName = key.includes("/") ? key.slice(0, key.indexOf("/")) : key
      if (!ALL_KEYS.includes(keyName)) throw new PolicyError(`invalid condition key '${key}'`)
      let values: ConditionValue[]
      if (raw.t === "array") {
        if (raw.v.length < 1) throw new PolicyError("invalid value")
        values = []
        for (const item of raw.v) {
          const parsed = conditionValue(item)
          if (values.some((seen) => seen.kind === parsed.kind && seen.v === parsed.v))
            throw new PolicyError(`duplicate value found '${valueString(parsed)}'`)
          values.push(parsed)
        }
      } else values = [conditionValue(raw)]
      out.push(makeCondition(fullName, qualifier, op, key, values))
    }
  }
  return out
}

const makeCondition = (
  name: string,
  qualifier: string,
  op: string,
  key: string,
  values: ConditionValue[],
): ConditionFn => {
  const keyName = key.includes("/") ? key.slice(0, key.indexOf("/")) : key
  const fn = (vals: ConditionValue[]): ConditionFn => ({ name, qualifier, op, key, values: vals })
  if (op.startsWith("String") || op === "BinaryEquals") {
    for (const value of values)
      if (value.kind !== "string")
        throw new PolicyError(`value must be a string for ${op} condition`)
    for (const value of values) {
      const s = value.v as string
      if (keyName === "s3:x-amz-copy-source") {
        const [bucket = "", object = ""] = s.replace(/^\//, "").split(/\/(.*)/s)
        if (!object)
          throw new PolicyError(
            `invalid value '${s}' for 's3:x-amz-copy-source' for ${op} condition`,
          )
        if (bucket.length < 3 || bucket.length > 63)
          throw new PolicyError("Bucket name cannot be shorter than 3 characters")
      }
      if (op === "StringLike" || op === "StringNotLike") continue
      if (keyName === "s3:x-amz-server-side-encryption-customer-algorithm" && s !== "AES256")
        throw new PolicyError(`invalid value '${s}' for '${keyName}' for ${op} condition`)
      if (keyName === "s3:x-amz-server-side-encryption" && s !== "AES256" && s !== "aws:kms")
        throw new PolicyError(`invalid value '${s}' for '${keyName}' for ${op} condition`)
      if (keyName === "s3:x-amz-metadata-directive" && s !== "COPY" && s !== "REPLACE")
        throw new PolicyError(`invalid value '${s}' for '${keyName}' for ${op} condition`)
      if (keyName === "s3:x-amz-content-sha256" && s === "")
        throw new PolicyError(`invalid empty value for '${keyName}' for ${op} condition`)
    }
    return fn(values)
  }
  if (op === "IpAddress" || op === "NotIpAddress") {
    const nets = values.map((value) => {
      if (value.kind !== "string")
        throw new PolicyError(
          `value ${valueString(value)} must be string representation of CIDR for ${op} condition`,
        )
      const text = value.v.includes("/") ? value.v : `${value.v}/32`
      const cidr = parseCidr(text)
      if (!cidr) throw new PolicyError(`value ${text} must be CIDR string for ${op} condition`)
      return { kind: "string", v: cidrString(cidr) } as ConditionValue
    })
    if (keyName !== "aws:SourceIp")
      throw new PolicyError(`only aws:SourceIp key is allowed for ${op} condition`)
    return fn(nets)
  }
  if (op === "Bool") {
    if (keyName !== "aws:SecureTransport")
      throw new PolicyError("only aws:SecureTransport key is allowed for Bool condition")
    if (values.length !== 1)
      throw new PolicyError("only one value is allowed for boolean condition")
    const value = values[0] as ConditionValue
    if (value.kind === "int") throw new PolicyError("value must be a boolean for boolean condition")
    if (value.kind === "string" && goParseBool(value.v) === undefined)
      throw new PolicyError("value must be a boolean string for boolean condition")
    return fn([{ kind: "string", v: valueString(value) }])
  }
  if (op === "Null") {
    if (values.length !== 1) throw new PolicyError("only one value is allowed for Null condition")
    const value = values[0] as ConditionValue
    if (value.kind === "int") throw new PolicyError("value must be a boolean for Null condition")
    const parsed = value.kind === "bool" ? value.v : goParseBool(value.v)
    if (parsed === undefined)
      throw new PolicyError("value must be a boolean string for Null condition")
    return fn([{ kind: "bool", v: parsed }])
  }
  if (op.startsWith("Numeric")) {
    if (values.length !== 1) throw new PolicyError(`only one value is allowed for ${op} condition`)
    const value = values[0] as ConditionValue
    let number: number
    if (value.kind === "int") number = value.v
    else if (value.kind === "string") {
      if (!/^[+-]?\d+$/.test(value.v))
        throw new PolicyError(
          `value ${value.v} must be a int for ${op} condition: strconv.Atoi: parsing ${JSON.stringify(value.v)}: invalid syntax`,
        )
      number = Number(value.v)
    } else throw new PolicyError(`value ${valueString(value)} must be a int for ${op} condition`)
    return fn([{ kind: "int", v: number }])
  }
  // Date*: one RFC 3339 value.
  if (values.length !== 1) throw new PolicyError(`only one value is allowed for ${op} condition`)
  const value = values[0] as ConditionValue
  if (value.kind !== "string" || Number.isNaN(Date.parse(value.v)))
    throw new PolicyError(
      `value ${valueString(value)} must be a time.Time string for ${op} condition`,
    )
  return fn([value])
}

const goParseBool = (value: string): boolean | undefined => {
  if (["1", "t", "T", "TRUE", "true", "True"].includes(value)) return true
  if (["0", "f", "F", "FALSE", "false", "False"].includes(value)) return false
  return undefined
}

const statementFields = [
  "Sid",
  "Effect",
  "Principal",
  "Action",
  "NotAction",
  "Resource",
  "NotResource",
  "Condition",
] as const

/** Go names the innermost struct and the full field path: `BPStatement.Statement.Effect`. */
const typeError = (got: J, field: string, type: string) =>
  new PolicyError(
    `json: cannot unmarshal ${kindName(got)} into Go struct field ${field.startsWith("Statement.") ? "BPStatement" : "subPolicy"}.${field} of type ${type}`,
  )

const decodeStatement = (value: J, saved: { error?: PolicyError }): Statement => {
  const statement: Statement = {
    sid: "",
    effect: "",
    principals: [],
    actions: [],
    notActions: [],
    resources: [],
    notResources: [],
    conditions: [],
  }
  if (value.t === "null") return statement
  if (value.t !== "object") {
    saved.error ??= typeError(value, "Statement", "policy.BPStatement")
    return statement
  }
  const f = fields(value.v, statementFields)
  const str = (raw: J | undefined, field: string, type: string): string => {
    if (!raw || raw.t === "null") return ""
    if (raw.t !== "string") {
      saved.error ??= typeError(raw, `Statement.${field}`, type)
      return ""
    }
    return raw.v
  }
  statement.sid = str(f.Sid, "Sid", "policy.ID")
  statement.effect = str(f.Effect, "Effect", "policy.Effect")
  if (f.Principal && f.Principal.t !== "null") {
    const raw = f.Principal
    if (raw.t === "object") {
      const aws = fields(raw.v, ["AWS"]).AWS
      statement.principals = aws && aws.t !== "null" ? stringSet(aws) : []
    } else if (raw.t === "string") {
      if (raw.v !== "*") throw new PolicyError(`invalid principal '${raw.v}'`)
      statement.principals = ["*"]
    } else
      throw new PolicyError(
        `json: cannot unmarshal ${kindName(raw)} into Go struct field BPStatement.Statement.Principal of type string`,
      )
  }
  const actions = (raw: J | undefined) => {
    if (!raw) return []
    const set = raw.t === "null" ? [] : stringSet(raw)
    if (set.length === 0) throw new PolicyError("empty actions not allowed")
    return set
  }
  statement.actions = actions(f.Action)
  statement.notActions = actions(f.NotAction)
  const resources = (raw: J | undefined) => {
    if (!raw || raw.t === "null") return []
    const out: Resource[] = []
    for (const item of stringSet(raw)) out.push(parseResource(item))
    return out
  }
  statement.resources = resources(f.Resource)
  statement.notResources = resources(f.NotResource)
  if (f.Condition && f.Condition.t !== "null")
    statement.conditions = conditionFunctions(f.Condition)
  return statement
}

const resourcesText = (resources: Resource[]) =>
  `[${resources.map(resourceString).sort().join(" ")}]`

const validateStatement = (statement: Statement) => {
  if (statement.effect !== "Allow" && statement.effect !== "Deny")
    throw new PolicyError(`invalid Effect ${statement.effect}`)
  if (statement.principals.length === 0)
    throw new PolicyError(`invalid Principal {[${statement.principals.join(" ")}]}`)
  if (!statement.actions.length && !statement.notActions.length)
    throw new PolicyError("Action must not be empty")
  if (statement.actions.length && statement.notActions.length)
    throw new PolicyError("Action and NotAction cannot be specified in the same statement")
  if (!statement.resources.length && !statement.notResources.length)
    throw new PolicyError("Resource must not be empty")
  if (statement.resources.length && statement.notResources.length)
    throw new PolicyError("Resource and NotResource cannot be specified in the same statement")
  const bucketPattern = (r: Resource) => !r.pattern.includes("/") || r.pattern === "*"
  const objectPattern = (r: Resource) => r.pattern.includes("/") || r.pattern.includes("*")
  for (const action of statement.actions) {
    const check = isObjectAction(action) ? objectPattern : bucketPattern
    for (const set of [statement.resources, statement.notResources])
      if (set.length && !set.some(check))
        throw new PolicyError(
          `unsupported Resource found ${resourcesText(set)} for action ${action}`,
        )
    const allowed = keysFor(action)
    const unsupported = statement.conditions
      .map((condition) => condition.key)
      .filter((key) => !allowed.has(key) && !allowed.has(key.split("/")[0] as string))
    if (unsupported.length)
      throw new PolicyError(
        `unsupported condition keys '[${[...new Set(unsupported)].join(" ")}]' used for action '${action}'`,
      )
  }
}

const validateBucket = (statement: Statement, bucket: string) => {
  for (const resource of [...statement.resources, ...statement.notResources]) {
    if (!resourceIsValid(resource)) throw new PolicyError("invalid resource")
    if (
      !wildcardMatch(resource.pattern, bucket) &&
      !matchAsPatternPrefix(resource.pattern, `${bucket}/`)
    )
      throw new PolicyError("bucket name does not match")
  }
}

const conditionText = (condition: ConditionFn) =>
  `${condition.name}:${condition.key}:${condition.values.map(valueString).sort().join(",")}`
const sameStatement = (a: Statement, b: Statement) => {
  const same = (x: string[], y: string[]) =>
    x.length === y.length && x.every((item) => y.includes(item))
  return (
    a.effect === b.effect &&
    same(a.principals, b.principals) &&
    same(a.actions, b.actions) &&
    same(a.notActions, b.notActions) &&
    same(a.resources.map(resourceString), b.resources.map(resourceString)) &&
    same(a.notResources.map(resourceString), b.notResources.map(resourceString)) &&
    same(a.conditions.map(conditionText), b.conditions.map(conditionText))
  )
}

/** `policy.ParseBucketPolicyConfig(body, bucket)`; throws `PolicyError`. */
export const parseBucketPolicy = (body: string, bucket: string): BucketPolicy => {
  const value = decodeJson(body)
  const policy: BucketPolicy = { id: "", version: "", statements: [], nilStatements: true }
  if (value.t === "null") return policy
  if (value.t !== "object")
    throw new PolicyError(
      `json: cannot unmarshal ${kindName(value)} into Go value of type policy.subPolicy`,
    )
  const f = fields(value.v, ["ID", "Version", "Statement"])
  const saved: { error?: PolicyError } = {}
  if (f.ID && f.ID.t !== "null") {
    if (f.ID.t === "string") policy.id = f.ID.v
    else saved.error ??= typeError(f.ID, "ID", "policy.ID")
  }
  if (f.Version && f.Version.t !== "null") {
    if (f.Version.t === "string") policy.version = f.Version.v
    else saved.error ??= typeError(f.Version, "Version", "string")
  }
  if (f.Statement && f.Statement.t !== "null") {
    if (f.Statement.t === "array") {
      policy.statements = f.Statement.v.map((item) => decodeStatement(item, saved))
      policy.nilStatements = false
    } else saved.error ??= typeError(f.Statement, "Statement", "[]policy.BPStatement")
  }
  if (saved.error) throw saved.error
  if (policy.version !== "2012-10-17" && policy.version !== "")
    throw new PolicyError(`invalid version '${policy.version}'`)
  for (const statement of policy.statements) validateStatement(statement)
  policy.statements = policy.statements.filter(
    (statement, index) =>
      !policy.statements.slice(0, index).some((earlier) => sameStatement(earlier, statement)),
  )
  for (const statement of policy.statements) {
    validateStatement(statement)
    validateBucket(statement, bucket)
  }
  return policy
}

/** Go's `json.Marshal` of a string (HTML-safe escaping). */
const goJson = (value: string) =>
  JSON.stringify(value).replace(
    /[<>&\u2028\u2029]/g,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
  )

const conditionJson = (value: ConditionValue) =>
  value.kind === "string" ? goJson(value.v) : String(value.v)

/** The JSON GetBucketPolicy answers. Throws `PolicyError` where Go's MarshalJSON would fail. */
export const marshalBucketPolicy = (policy: BucketPolicy): string => {
  const statements = policy.statements.map((statement) => {
    if (!statement.actions.length)
      throw new PolicyError(
        "json: error calling MarshalJSON for type *policy.BucketPolicy: json: error calling MarshalJSON for type policy.ActionSet: empty actions not allowed",
      )
    const list = (items: string[]) => `[${[...items].sort().map(goJson).join(",")}]`
    const grouped = new Map<string, Map<string, ConditionValue[]>>()
    for (const condition of statement.conditions) {
      const byKey = grouped.get(condition.name) ?? new Map<string, ConditionValue[]>()
      byKey.set(condition.key, condition.values)
      grouped.set(condition.name, byKey)
    }
    const sorted = <T>(map: Map<string, T>) =>
      [...map].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    const condition = sorted(grouped)
      .map(
        ([name, byKey]) =>
          `${goJson(name)}:{${sorted(byKey)
            .map(([key, values]) => `${goJson(key)}:[${values.map(conditionJson).join(",")}]`)
            .join(",")}}`,
      )
      .join(",")
    return `{${[
      statement.sid ? `"Sid":${goJson(statement.sid)}` : "",
      `"Effect":${goJson(statement.effect)}`,
      `"Principal":{"AWS":${list(statement.principals)}}`,
      `"Action":${list(statement.actions)}`,
      statement.notActions.length ? `"NotAction":${list(statement.notActions)}` : "",
      `"Resource":${list(statement.resources.map(resourceString))}`,
      statement.notResources.length
        ? `"NotResource":${list(statement.notResources.map(resourceString))}`
        : "",
      statement.conditions.length ? `"Condition":{${condition}}` : "",
    ]
      .filter(Boolean)
      .join(",")}}`
  })
  return `{${policy.id ? `"ID":${goJson(policy.id)},` : ""}"Version":${goJson(policy.version)},"Statement":${
    policy.nilStatements ? "null" : `[${statements.join(",")}]`
  }}`
}

// ── evaluation ───────────────────────────────────────────────────────────────────────────

export type ConditionValues = Record<string, string[]>

/** Go's `http.CanonicalHeaderKey`. */
const canonical = (name: string) =>
  /^[A-Za-z0-9-]+$/.test(name)
    ? name
        .split("-")
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
        .join("-")
    : name

/** The key's value name: `s3:prefix` → `prefix`, `aws:Referer` → `Referer`. */
const valueName = (key: string) => {
  const name = key.includes("/") ? key.slice(0, key.indexOf("/")) : key
  const variable = key.includes("/") ? key.slice(key.indexOf("/")) : ""
  const colon = name.indexOf(":")
  const trimmed =
    colon >= 0 && ["aws", "jwt", "ldap", "sts", "svc", "s3"].includes(name.slice(0, colon))
      ? name.slice(colon + 1)
      : name
  return trimmed + variable
}
const valuesByKey = (values: ConditionValues, key: string) => {
  const name = valueName(key)
  return values[canonical(name)] ?? values[name] ?? []
}

const substitute = (value: string, values: ConditionValues) => {
  let out = value
  for (const key of COMMON_KEYS) {
    const found = values[valueName(key)]
    if (found?.[0]) out = out.split(`\${${key}}`).join(found[0])
  }
  return out
}

const ipNumber = (value: string) => {
  const bytes = ipv4(value)
  return bytes ? ipValue(bytes) : undefined
}

const evaluate = (condition: ConditionFn, values: ConditionValues): boolean => {
  const { op, qualifier } = condition
  const request = valuesByKey(values, condition.key)
  if (op === "StringLike" || op === "StringNotLike") {
    const patterns = condition.values.map((value) => substitute(valueString(value), values))
    let result = qualifier === "ForAllValues"
    for (const value of request) {
      const matched = patterns.some((pattern) => wildcardMatch(pattern, value))
      if (qualifier === "ForAllValues") {
        if (!matched) {
          result = false
          break
        }
      } else if (matched) {
        result = true
        break
      }
    }
    return op === "StringNotLike" ? !result : result
  }
  if (op.startsWith("String") || op === "BinaryEquals") {
    const ignoreCase = op.includes("IgnoreCase")
    const norm = (value: string) => (ignoreCase ? value.toLowerCase() : value)
    const wanted = new Set(
      condition.values.map((value) =>
        norm(op === "BinaryEquals" ? valueString(value) : substitute(valueString(value), values)),
      ),
    )
    const got = new Set(request.map(norm))
    const common = [...got].filter((value) => wanted.has(value))
    const result =
      qualifier === "ForAllValues"
        ? got.size === 0 || common.length === got.size
        : common.length > 0
    return op.includes("Not") ? !result : result
  }
  if (op === "IpAddress" || op === "NotIpAddress") {
    let result = false
    const ips = request.map(ipNumber)
    if (ips.every((ip) => ip !== undefined))
      result = ips.some((ip) =>
        condition.values.some((value) => {
          const cidr = parseCidr(valueString(value))
          return cidr !== undefined && ((ip as number) & cidr.mask) >>> 0 === cidr.network
        }),
      )
    return op === "NotIpAddress" ? !result : result
  }
  if (op === "Bool")
    return request.length > 0 && request[0] === valueString(condition.values[0] as ConditionValue)
  if (op === "Null")
    return (condition.values[0] as ConditionValue).v ? request.length === 0 : request.length !== 0
  if (op.startsWith("Numeric")) {
    if (request.length === 0) return op === "NumericGreaterThanIfExists"
    if (!/^[+-]?\d+$/.test(request[0] as string)) return false
    const got = Number(request[0])
    const want = (condition.values[0] as ConditionValue).v as number
    switch (op) {
      case "NumericEquals":
        return got === want
      case "NumericNotEquals":
        return got !== want
      case "NumericLessThan":
        return got < want
      case "NumericLessThanEquals":
        return got <= want
      case "NumericGreaterThan":
      case "NumericGreaterThanIfExists":
        return got > want
      default:
        return got >= want
    }
  }
  // Date*
  if (request.length === 0) return false
  const got = Date.parse(request[0] as string)
  const want = Date.parse(valueString(condition.values[0] as ConditionValue))
  if (Number.isNaN(got)) return false
  switch (op) {
    case "DateEquals":
      return got === want
    case "DateNotEquals":
      return got !== want
    case "DateLessThan":
      return got < want
    case "DateLessThanEquals":
      return got <= want
    case "DateGreaterThan":
      return got > want
    default:
      return got >= want
  }
}

const resourceMatches = (resource: Resource, target: string, values: ConditionValues) => {
  let pattern = resource.pattern
  if (pattern.includes("$")) pattern = substitute(pattern, values)
  const clean = cleanPath(target)
  if (clean !== "." && clean === pattern) return true
  return wildcardMatch(pattern, target)
}

/** Go's `path.Clean`. */
const cleanPath = (value: string) => {
  if (value === "") return "."
  const rooted = value.startsWith("/")
  const out: string[] = []
  for (const part of value.split("/")) {
    if (part === "" || part === ".") continue
    if (part === "..") {
      if (out.length && out[out.length - 1] !== "..") out.pop()
      else if (!rooted) out.push("..")
    } else out.push(part)
  }
  const joined = (rooted ? "/" : "") + out.join("/")
  return joined === "" ? "." : joined
}

const actionMatches = (patterns: string[], action: string) =>
  patterns.some(
    (pattern) =>
      wildcardMatch(pattern, action) ||
      (pattern === "s3:GetObjectVersion" && action === "s3:GetObject"),
  )

const statementMatches = (
  statement: Statement,
  action: string,
  bucket: string,
  object: string,
  values: ConditionValues,
) => {
  if (!statement.principals.some((principal) => wildcardMatch(principal, "", true))) return false
  if (
    (statement.actions.length && !actionMatches(statement.actions, action)) ||
    actionMatches(statement.notActions, action)
  )
    return false
  const target = object ? `${bucket}${object.startsWith("/") ? "" : "/"}${object}` : bucket
  if (
    statement.resources.length &&
    !statement.resources.some((resource) => resourceMatches(resource, target, values))
  )
    return false
  if (
    statement.notResources.length &&
    statement.notResources.some((resource) => resourceMatches(resource, target, values))
  )
    return false
  return statement.conditions.every((condition) => evaluate(condition, values))
}

/** `BucketPolicy.IsAllowed` for a non-owner. */
export const policyAllows = (
  policy: BucketPolicy,
  action: string,
  bucket: string,
  object: string,
  values: ConditionValues,
) => {
  for (const statement of policy.statements)
    if (statement.effect === "Deny" && statementMatches(statement, action, bucket, object, values))
      return false
  return policy.statements.some(
    (statement) =>
      statement.effect === "Allow" && statementMatches(statement, action, bucket, object, values),
  )
}

/** The bucket's stored policy, if any. */
export const storedPolicy = (core: S3Core, bucket: string): BucketPolicy | undefined => {
  if (!core.bucket(bucket)) return undefined
  const stored = core.config(bucket, "policy")
  if (stored === undefined) return undefined
  try {
    return parseBucketPolicy(stored, bucket)
  } catch {
    return undefined
  }
}

/** The client address MinIO's `GetSourceIPRaw` would see (forwarding headers, else loopback). */
const sourceIp = (headers: Headers) => {
  const forwardedFor = headers.get("x-forwarded-for")
  if (forwardedFor) {
    const comma = forwardedFor.indexOf(", ")
    return comma < 0 ? forwardedFor : forwardedFor.slice(0, comma)
  }
  const real = headers.get("x-real-ip")
  if (real) return real
  const forwarded = /(?:^|[;,\s])for=([^;,]+)/i.exec(headers.get("forwarded") ?? "")?.[1]
  if (forwarded) return forwarded.replace(/"/g, "")
  // The fetch handler has no socket address: requests are assumed to be local.
  return "127.0.0.1"
}

/** `getConditionValues(r, region, auth.AnonymousCredentials)`. */
export const conditionValues = (ctx: Ctx, objectTagging?: string): ConditionValues => {
  const now = new Date(ctx.now)
  let versionId = ctx.query.get("versionId") ?? ""
  if (!versionId) {
    const source = ctx.headers.get("x-amz-copy-source")
    if (source) {
      try {
        versionId = new URL(source, "http://copy.source").searchParams.get("versionId") ?? ""
      } catch {}
    }
  }
  const values: ConditionValues = {
    CurrentTime: [now.toISOString().replace(/\.\d+Z$/, "Z")],
    EpochTime: [String(Math.floor(ctx.now / 1000))],
    SecureTransport: [String(ctx.url.protocol === "https:")],
    SourceIp: [sourceIp(ctx.headers)],
    UserAgent: [ctx.headers.get("user-agent") ?? ""],
    Referer: [ctx.headers.get("referer") ?? ""],
    principaltype: ["Anonymous"],
    userid: [""],
    username: [""],
    versionid: [versionId],
    signatureversion: [""],
    authType: [""],
  }
  if (ctx.core.region) values.LocationConstraint = [ctx.core.region]
  const add = (key: string, value: string) => {
    values[key] = [...(values[key] ?? []), value]
  }
  const tagging = objectTagging ?? ctx.headers.get("x-amz-tagging")
  if (tagging) {
    const keys: string[] = []
    for (const [key, value] of new URLSearchParams(tagging)) {
      values[`ExistingObjectTag/${key}`] = [value]
      values[`RequestObjectTag/${key}`] = [value]
      keys.push(key)
    }
    values.RequestObjectTagKeys = keys
  }
  for (const [name, value] of ctx.headers) {
    if (name === "x-amz-tagging") continue
    const key = canonical(name)
    if (
      key === "X-Amz-Object-Lock-Mode" ||
      key === "X-Amz-Object-Lock-Legal-Hold" ||
      key === "X-Amz-Object-Lock-Retain-Until-Date"
    )
      values[key.slice("X-Amz-".length)] = [value]
    else add(key, value)
  }
  for (const [name, value] of ctx.query) add(name, value)
  return values
}

// ── operations → MinIO policy actions ────────────────────────────────────────────────────

const ACTIONS: Partial<Record<Operation, string>> = {
  HeadObject: "s3:GetObject",
  GetObject: "s3:GetObject",
  GetObjectLambda: "s3:GetObject",
  SelectObjectContent: "s3:GetObject",
  UploadPart: "s3:PutObject",
  UploadPartCopy: "s3:PutObject",
  CompleteMultipartUpload: "s3:PutObject",
  CreateMultipartUpload: "s3:PutObject",
  PutObject: "s3:PutObject",
  CopyObject: "s3:PutObject",
  PutObjectExtract: "s3:PutObject",
  AbortMultipartUpload: "s3:AbortMultipartUpload",
  ListParts: "s3:ListMultipartUploadParts",
  GetObjectAcl: "s3:GetBucketPolicy",
  PutObjectAcl: "s3:PutBucketPolicy",
  GetObjectTagging: "s3:GetObjectTagging",
  PutObjectTagging: "s3:PutObjectTagging",
  DeleteObjectTagging: "s3:DeleteObjectTagging",
  GetObjectRetention: "s3:GetObjectRetention",
  GetObjectLegalHold: "s3:GetObjectLegalHold",
  PutObjectRetention: "s3:PutObjectRetention",
  PutObjectLegalHold: "s3:PutObjectLegalHold",
  DeleteObject: "s3:DeleteObject",
  RestoreObject: "s3:RestoreObject",
  GetBucketLocation: "s3:GetBucketLocation",
  GetBucketPolicy: "s3:GetBucketPolicy",
  GetBucketLifecycle: "s3:GetLifecycleConfiguration",
  GetBucketEncryption: "s3:GetEncryptionConfiguration",
  GetObjectLockConfiguration: "s3:GetBucketObjectLockConfiguration",
  GetBucketReplication: "s3:GetReplicationConfiguration",
  GetBucketVersioning: "s3:GetBucketVersioning",
  GetBucketNotification: "s3:GetBucketNotification",
  ResetBucketReplicationStatus: "s3:ResetBucketReplicationState",
  GetBucketAcl: "s3:GetBucketPolicy",
  PutBucketAcl: "s3:PutBucketPolicy",
  GetBucketCors: "s3:GetBucketCors",
  PutBucketCors: "s3:PutBucketCors",
  DeleteBucketCors: "s3:DeleteBucketCors",
  GetBucketWebsite: "s3:GetBucketPolicy",
  GetBucketAccelerate: "s3:GetBucketPolicy",
  GetBucketRequestPayment: "s3:GetBucketPolicy",
  GetBucketLogging: "s3:GetBucketPolicy",
  GetBucketTagging: "s3:GetBucketTagging",
  DeleteBucketTagging: "s3:PutBucketTagging",
  ListMultipartUploads: "s3:ListBucketMultipartUploads",
  ListObjectsV2M: "s3:ListBucket",
  ListObjectsV2: "s3:ListBucket",
  ListObjectsV1: "s3:ListBucket",
  ListObjectVersionsM: "s3:ListBucketVersions",
  ListObjectVersions: "s3:ListBucketVersions",
  GetBucketPolicyStatus: "s3:GetBucketPolicyStatus",
  PutBucketLifecycle: "s3:PutLifecycleConfiguration",
  PutBucketReplication: "s3:PutReplicationConfiguration",
  PutBucketEncryption: "s3:PutEncryptionConfiguration",
  PutBucketPolicy: "s3:PutBucketPolicy",
  PutObjectLockConfiguration: "s3:PutBucketObjectLockConfiguration",
  PutBucketTagging: "s3:PutBucketTagging",
  PutBucketVersioning: "s3:PutBucketVersioning",
  PutBucketNotification: "s3:PutBucketNotification",
  ResetBucketReplicationStart: "s3:ResetBucketReplicationState",
  CreateBucket: "s3:CreateBucket",
  HeadBucket: "s3:HeadBucket",
  DeleteObjects: "s3:DeleteObject",
  DeleteBucketPolicy: "s3:DeleteBucketPolicy",
  DeleteBucketReplication: "s3:PutReplicationConfiguration",
  DeleteBucketLifecycle: "s3:PutLifecycleConfiguration",
  DeleteBucketEncryption: "s3:PutEncryptionConfiguration",
  DeleteBucket: "s3:DeleteBucket",
  GetBucketReplicationMetricsV2: "s3:GetReplicationConfiguration",
  GetBucketReplicationMetrics: "s3:GetReplicationConfiguration",
  ValidateBucketReplicationCreds: "s3:GetReplicationConfiguration",
  ListBuckets: "s3:ListAllMyBuckets",
}

/** Operations that authorize inside their handler (MinIO checks something else first). */
const DEFERRED = new Set<Operation>([
  "GetObjectTagging",
  "PutObjectTagging",
  "DeleteObjectTagging",
  "PutBucketTagging",
  // No authorization at all (`DeleteBucketWebsiteHandler` only answers 200).
  "DeleteBucketWebsite",
])
/** Operations whose authorization runs with no object name (no `<Key>` in their errors). */
const BUCKET_SCOPED = new Set<Operation>(["GetObjectAcl", "PutObjectAcl"])

/** Whether an anonymous request may perform `action` on `bucket`/`object`. */
export const anonymousAllowed = (
  ctx: Ctx,
  action: string,
  object = ctx.key,
  bucket = ctx.bucket,
  tagging?: string,
) => {
  if (action === "s3:ListAllMyBuckets") return false
  const policy = storedPolicy(ctx.core, bucket)
  return (
    policy !== undefined &&
    policyAllows(policy, action, bucket, object, conditionValues(ctx, tagging))
  )
}

const denied = (options: { key?: string; headersOnly?: boolean } = {}): never =>
  fail("AccessDenied", {
    ...(options.key !== undefined ? { key: options.key } : {}),
    ...(options.headersOnly ? { headersOnly: true } : {}),
  })

/**
 * `checkRequestAuthType` for a handler that authorizes late. A no-op for the owner; for an
 * anonymous request, AccessDenied unless the bucket policy allows `action`.
 */
export const requireAccess = (ctx: Ctx, action: string, object = ctx.key) => {
  if (!ctx.identity.anonymous) return
  if (!anonymousAllowed(ctx, action, object)) denied({ key: object })
}

/** The anonymous GET/HEAD of a missing key is NoSuchKey when s3:ListBucket is allowed. */
const missingKeyIsVisible = (ctx: Ctx) => {
  if (!anonymousAllowed(ctx, "s3:ListBucket", "")) return false
  if (!ctx.core.bucket(ctx.bucket)) return false
  const versionId = ctx.query.get("versionId")
  const version = versionId
    ? ctx.core.version(ctx.bucket, ctx.key, versionId)
    : ctx.core.head(ctx.bucket, ctx.key)
  return !version || (!versionId && version.deleteMarker === true)
}

/** Authorize a request before its handler runs (MinIO's `checkRequestAuthType`). */
export const authorize = async (ctx: Ctx): Promise<void> => {
  if (!ctx.identity.anonymous) return
  const { op } = ctx
  if (DEFERRED.has(op)) return
  const object = BUCKET_SCOPED.has(op) ? "" : ctx.key
  const allowed = (action: string, key = object) => anonymousAllowed(ctx, action, key)
  switch (op) {
    case "HeadBucket":
      if (allowed("s3:HeadBucket") || allowed("s3:ListBucket")) return
      return denied()
    case "ListObjectVersions":
    case "ListObjectVersionsM":
      if (allowed("s3:ListBucketVersions") || allowed("s3:ListBucket")) return
      return denied()
    case "GetBucketPolicyStatus":
      if (allowed("s3:GetBucketPolicyStatus")) return
      return denied({ headersOnly: true })
    case "GetObject":
    case "HeadObject": {
      // `authenticateRequest` lets an anonymous request through; `authorizeRequest` then runs
      // with the stored object's tags as `ExistingObjectTag` (or, missing, before the error).
      const versionId = ctx.query.get("versionId")
      const found = versionId
        ? ctx.core.version(ctx.bucket, ctx.key, versionId)
        : ctx.core.head(ctx.bucket, ctx.key)
      const tagging = found && !found.deleteMarker ? found.tagging : undefined
      if (anonymousAllowed(ctx, "s3:GetObject", object, ctx.bucket, tagging)) return
      return denied()
    }
    case "SelectObjectContent":
      if (allowed("s3:GetObject")) return
      if (missingKeyIsVisible(ctx)) fail("NoSuchKey")
      return denied()
    case "GetObjectAttributes": {
      const versioned = Boolean(ctx.query.get("versionId"))
      const ok = versioned
        ? allowed("s3:GetObjectVersionAttributes") || allowed("s3:GetObjectVersion")
        : allowed("s3:GetObjectAttributes") || allowed("s3:GetObject")
      if (ok) return
      return denied()
    }
    case "CopyObject":
    case "UploadPartCopy": {
      if (!allowed("s3:PutObject")) return denied()
      const source = decodeURIComponent(
        (ctx.headers.get("x-amz-copy-source") ?? "").split("?")[0] ?? "",
      ).replace(/^\//, "")
      const slash = source.indexOf("/")
      const srcBucket = slash < 0 ? source : source.slice(0, slash)
      const srcKey = slash < 0 ? "" : source.slice(slash + 1)
      if (anonymousAllowed(ctx, "s3:GetObject", srcKey, srcBucket)) return
      // The source check names the source object in the error.
      return fail("AccessDenied", { key: srcKey, bucket: srcBucket })
    }
    case "ListenNotification":
      if (allowed(ctx.bucket ? "s3:ListenBucketNotification" : "s3:ListenNotification")) return
      return denied()
    default: {
      const action = ACTIONS[op]
      if (action && allowed(action)) return
      return denied(BUCKET_SCOPED.has(op) ? { key: "" } : {})
    }
  }
}

/** PutBucketPolicy's validation failure as MinIO renders it. */
export const policyError = (error: unknown): S3Error => {
  if (error instanceof PolicyError) {
    if (error.message.startsWith("json: error calling MarshalJSON"))
      return new S3Error("InternalError", {
        message: `We encountered an internal error, please try again.: cause(${error.message})`,
      })
    return new S3Error("MalformedXML", { code: "MalformedPolicy", message: error.message })
  }
  throw error
}
