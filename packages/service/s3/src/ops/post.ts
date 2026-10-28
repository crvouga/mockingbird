/**
 * Browser POST uploads, after MinIO's `PostPolicyBucketHandler` (`bucket-handlers.go`) and
 * `postpolicyform.go`: a `multipart/form-data` form carrying the object, a base64 JSON policy and
 * its SigV4 (or SigV2) signature. The handler authenticates the form itself, checks the policy's
 * expiration and conditions, then stores the object like PutObject.
 */
import { checkKey, hex, hmac256, hmacRaw, parseCredential, signingKey } from "../auth.js"
import { type Ctx, type Handlers, ok, xmlResponse } from "../context.js"
import { md5Base64, md5Hex } from "../digest.js"
import { fail, S3Error } from "../errors.js"
import { typeByExtension } from "../mimedb.generated.js"
import { el } from "../xml.js"
import { requireBucket } from "./common.js"

const encoder = new TextEncoder()
const utf8 = new TextDecoder()
/** Bytes as one char per byte (not `TextDecoder("latin1")`, which is windows-1252). */
const binary = (bytes: Uint8Array) => {
  let out = ""
  for (let index = 0; index < bytes.length; index += 0x8000)
    out += String.fromCharCode(...bytes.subarray(index, index + 0x8000))
  return out
}
const latin1 = { decode: binary }

const malformed = (detail?: string) =>
  new S3Error("MalformedPOSTRequest", {
    ...(detail === undefined
      ? {}
      : {
          message: `The body of your POST request is not well-formed multipart/form-data. (${detail})`,
        }),
  })

/** Go's `http.CanonicalHeaderKey`. */
const canonical = (name: string) => {
  if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(name)) return name
  return name
    .toLowerCase()
    .replace(/(^|-)([a-z])/g, (_, dash: string, letter: string) => `${dash}${letter.toUpperCase()}`)
}

/** The form fields, Go `http.Header` style: canonical names, every value kept in order. */
class FormValues {
  readonly values = new Map<string, string[]>()
  add(name: string, value: string) {
    const key = canonical(name)
    this.values.set(key, [...(this.values.get(key) ?? []), value])
  }
  set(name: string, value: string) {
    this.values.set(canonical(name), [value])
  }
  get(name: string) {
    return this.values.get(canonical(name))?.[0] ?? ""
  }
  has(name: string) {
    return this.values.has(canonical(name))
  }
}

// ── multipart/form-data, as Go's mime/multipart reads it ───────────────────

type Part = { name: string; filename: string; body: Uint8Array | undefined }

/** `mime.ParseMediaType` parameters (quoted strings unescaped). */
const mediaParams = (value: string) => {
  const params = new Map<string, string>()
  const pattern = /;\s*([^\s=;]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^\s;]*))/g
  for (const match of value.matchAll(pattern))
    params.set(
      (match[1] as string).toLowerCase(),
      match[2] !== undefined ? match[2].replace(/\\(.)/g, "$1") : (match[3] ?? ""),
    )
  return { type: (value.split(";")[0] ?? "").trim().toLowerCase(), params }
}

const indexOf = (haystack: Uint8Array, needle: Uint8Array, from: number) => {
  outer: for (let index = from; index + needle.length <= haystack.length; index++) {
    for (let offset = 0; offset < needle.length; offset++)
      if (haystack[index + offset] !== needle[offset]) continue outer
    return index
  }
  return -1
}

/**
 * The parts of a form, read one at a time as MinIO reads them. A part whose closing delimiter
 * never comes has an `undefined` body (reading it is Go's `unexpected EOF`).
 */
function* multipartParts(body: Uint8Array, boundary: string): Generator<Part> {
  const dash = `--${boundary}`
  const isDelimiter = (line: string) =>
    line.startsWith(dash) && /^[ \t]*\r?$/.test(line.slice(dash.length))
  const isFinal = (line: string) =>
    line.startsWith(`${dash}--`) && /^[ \t]*\r?$/.test(line.slice(dash.length + 2))
  let position = 0
  const readLine = () => {
    const end = body.indexOf(10, position)
    if (end < 0) {
      const rest = latin1.decode(body.subarray(position))
      position = body.length
      return { line: rest, eof: true }
    }
    const line = latin1.decode(body.subarray(position, end))
    position = end + 1
    return { line, eof: false }
  }
  // The preamble, up to the first delimiter. Any error reading it ends the form (MinIO's
  // `errors.Is(err, io.EOF)`).
  for (;;) {
    const { line, eof } = readLine()
    if (eof) return
    if (isDelimiter(line)) break
    if (isFinal(line)) return
  }
  const delimiter = encoder.encode(`\r\n${dash}`)
  for (;;) {
    const headers = new Map<string, string>()
    for (;;) {
      const { line, eof } = readLine()
      if (eof) throw malformed("unexpected EOF")
      const text = line.replace(/\r$/, "")
      if (text === "") break
      const colon = text.indexOf(":")
      if (colon <= 0) throw malformed(`malformed MIME header line: ${text}`)
      headers.set(text.slice(0, colon).trim().toLowerCase(), text.slice(colon + 1).trim())
    }
    const disposition = mediaParams(headers.get("content-disposition") ?? "")
    const isForm = disposition.type === "form-data"
    const rawName = isForm ? (disposition.params.get("name") ?? "") : ""
    const rawFile = disposition.params.get("filename") ?? ""
    const filename = rawFile ? (rawFile.replace(/\/+$/, "").split("/").pop() ?? "") || "/" : ""
    // The part's body runs to the next `\r\n--boundary` followed by `--` or a line end.
    let search = position
    let end = -1
    for (;;) {
      const found = indexOf(body, delimiter, search)
      if (found < 0) break
      const after = latin1.decode(
        body.subarray(found + delimiter.length, found + delimiter.length + 64),
      )
      if (after.startsWith("--") || /^[ \t]*\r?\n/.test(after)) {
        end = found
        break
      }
      search = found + 1
    }
    const name = utf8.decode(latin1Bytes(rawName))
    const file = utf8.decode(latin1Bytes(filename))
    if (end < 0) {
      yield { name, filename: file, body: undefined }
      throw malformed("unexpected EOF")
    }
    yield { name, filename: file, body: body.subarray(position, end) }
    position = end + 2
    const { line } = readLine()
    if (isFinal(line)) return
    if (!isDelimiter(line))
      throw malformed(`multipart: expecting a new Part; got line ${JSON.stringify(line)}`)
  }
}

const latin1Bytes = (value: string) => Uint8Array.from(value, (char) => char.charCodeAt(0) & 0xff)
/** A UTF-8 string as one char per byte, the way header values reach the emulator. */
const asHeaderValue = (value: string) => latin1.decode(encoder.encode(value))

// ── the policy document (postpolicyform.go) ─────────────────────────────────

/** Go's `%s` of a decoded JSON value. */
const goString = (value: unknown): string => {
  if (typeof value === "string") return value
  if (typeof value === "number") return `%!s(float64=${value})`
  if (typeof value === "boolean") return `%!s(bool=${value})`
  if (value === null) return "%!s(<nil>)"
  if (Array.isArray(value)) return `[${value.map(goString).join(" ")}]`
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a < b ? -1 : 1,
  )
  return `map[${entries.map(([key, item]) => `${key}:${goString(item)}`).join(" ")}]`
}
/** Go's `reflect.TypeOf(value).String()` for a decoded JSON value. */
const goType = (value: unknown) =>
  Array.isArray(value)
    ? "[]interface {}"
    : value === null
      ? "<nil>"
      : typeof value === "object"
        ? "map[string]interface {}"
        : typeof value === "number"
          ? "float64"
          : typeof value === "boolean"
            ? "bool"
            : "string"

type Condition = { operator: string; key: string; value: string }
type PostPolicy = {
  expiration: number
  conditions: Condition[]
  length?: { min: number; max: number }
}

const policyError = (detail: string) =>
  new S3Error("PostPolicyConditionInvalidFormat", {
    message: `Invalid according to Policy: Policy Condition failed '(${detail})'`,
  })

const RFC3339 = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d+)?(Z|[+-]\d{2}:\d{2})$/

/** `time.Parse(time.RFC3339Nano, value)` → epoch ms, or the Go error text. */
const parseExpiration = (value: string): number | string => {
  const match = RFC3339.exec(value)
  const ms = match ? Date.parse(value) : Number.NaN
  if (!Number.isNaN(ms)) return ms
  return `parsing time ${JSON.stringify(value)} as "2006-01-02T15:04:05.999999999Z07:00": cannot parse ${JSON.stringify(value)} as "2006"`
}

/** Go's `strconv.Atoi` / float truncation, as `toInteger` does. */
const toInteger = (value: unknown): number => {
  if (typeof value === "number") return Math.trunc(value)
  if (typeof value === "string") {
    if (!/^[+-]?\d+$/.test(value))
      throw policyError(`strconv.Atoi: parsing ${JSON.stringify(value)}: invalid syntax`)
    return Number(value)
  }
  throw policyError("Invalid number format")
}

/** MinIO's `parsePostPolicyForm`. */
const parsePolicy = (text: string): PostPolicy => {
  let document: unknown
  try {
    document = JSON.parse(text)
  } catch (error) {
    throw policyError(error instanceof Error ? error.message : String(error))
  }
  if (!document || typeof document !== "object" || Array.isArray(document))
    throw policyError("json: cannot unmarshal into Go value of type struct")
  const seen = new Set<string>()
  // Duplicate top-level keys (sanitizePolicy): JSON.parse keeps the last, so scan the text.
  for (const key of topLevelKeys(text)) {
    if (seen.has(key))
      throw policyError(`input policy has multiple ${key}, please fix your client code`)
    seen.add(key)
  }
  let expirationText = ""
  let rawConditions: unknown[] = []
  for (const [key, value] of Object.entries(document as Record<string, unknown>)) {
    const lower = key.toLowerCase()
    if (lower === "expiration") expirationText = typeof value === "string" ? value : ""
    else if (lower === "conditions") rawConditions = Array.isArray(value) ? value : []
    else throw policyError(`json: unknown field ${JSON.stringify(key)}`)
  }
  const expiration = parseExpiration(expirationText)
  if (typeof expiration === "string") throw policyError(expiration)
  const policy: PostPolicy = { expiration, conditions: [] }
  for (const condition of rawConditions) {
    if (Array.isArray(condition)) {
      if (condition.length !== 3)
        throw policyError(
          `Malformed conditional fields ${goString(condition)} of type ${goType(condition)} found in POST policy form`,
        )
      const operator = typeof condition[0] === "string" ? condition[0].toLowerCase() : ""
      if (operator === "eq" || operator === "starts-with") {
        if (condition.some((item) => typeof item !== "string"))
          throw policyError(
            `Unknown type ${goType(condition)} of conditional field value ${goString(condition)} found in POST policy form`,
          )
        const matchType = (condition[1] as string).toLowerCase()
        const value = condition[2] as string
        if (!matchType.startsWith("$"))
          throw policyError(
            `Invalid according to Policy: Policy Condition failed: [${operator}, ${matchType}, ${value}]`,
          )
        policy.conditions.push({ operator, key: matchType, value })
      } else if (operator === "content-length-range") {
        policy.length = { min: toInteger(condition[1]), max: toInteger(condition[2]) }
      } else
        throw policyError(
          `Unknown type ${goType(condition)} of conditional field value ${goString(condition)} found in POST policy form`,
        )
    } else if (condition && typeof condition === "object") {
      for (const [key, value] of Object.entries(condition as Record<string, unknown>)) {
        if (typeof value !== "string")
          throw policyError(
            `Unknown type ${goType(condition)} of conditional field value ${goString(condition)} found in POST policy form`,
          )
        policy.conditions.push({ operator: "eq", key: `$${key.toLowerCase()}`, value })
      }
    } else
      throw policyError(
        `Unknown field ${goString(condition)} of type ${goType(condition)} found in POST policy form`,
      )
  }
  return policy
}

/** The keys of the top-level JSON object, in order, duplicates included. */
const topLevelKeys = (text: string) => {
  const keys: string[] = []
  let depth = 0
  let index = 0
  let expectKey = false
  while (index < text.length) {
    const char = text[index] as string
    if (char === '"') {
      let end = index + 1
      while (end < text.length && text[end] !== '"') end += text[end] === "\\" ? 2 : 1
      const raw = text.slice(index, end + 1)
      if (depth === 1 && expectKey) keys.push(JSON.parse(raw) as string)
      expectKey = false
      index = end + 1
      continue
    }
    if (char === "{" || char === "[") {
      depth++
      expectKey = char === "{" && depth === 1
    } else if (char === "}" || char === "]") depth--
    else if (char === "," && depth === 1) expectKey = true
    index++
  }
  return keys
}

const STARTS_WITH: Record<string, boolean> = {
  $acl: true,
  $bucket: false,
  "$cache-control": true,
  "$content-type": true,
  "$content-disposition": true,
  "$content-encoding": true,
  $expires: true,
  $key: true,
  $success_action_redirect: true,
  $redirect: true,
  $success_action_status: true,
  "$x-amz-algorithm": false,
  "$x-amz-credential": false,
  "$x-amz-date": false,
}
const EXEMPT = new Set([
  "X-Amz-Signature",
  "File",
  "Policy",
  "X-Amz-Server-Side-Encryption-Aws-Kms-Key-Id",
  "X-Amz-Server-Side-Encryption-Context",
  "X-Amz-Server-Side-Encryption-Customer-Algorithm",
  "X-Amz-Server-Side-Encryption-Customer-Key",
  "X-Amz-Server-Side-Encryption-Customer-Key-Md5",
])

const denied = (detail: string) =>
  new S3Error("AccessDenied", { message: `Access Denied. (${detail})` })

/** MinIO's `checkPostPolicy`. */
const checkPolicy = (form: FormValues, policy: PostPolicy, now: number) => {
  if (!(policy.expiration > now)) throw denied("Invalid according to Policy: Policy expired")
  const mustFind = new Map<string, string[]>()
  for (const [key, values] of form.values)
    if (!EXEMPT.has(key) && !key.startsWith("X-Ignore-")) mustFind.set(key, values)
  for (const { operator, key, value } of policy.conditions) {
    const name = canonical(key.replace(/^\$/, ""))
    const values = mustFind.get(name) ?? []
    if (values.length >= 2)
      throw denied(
        `Invalid according to Policy: Policy Condition failed: [${operator}, ${key}, ${value}]. FormValues have multiple values: [${values.join(", ")}]`,
      )
    const actual = form.get(name)
    const holds = operator === "eq" ? actual === value : actual.startsWith(value)
    if (Object.hasOwn(STARTS_WITH, key)) {
      if (operator === "starts-with" && !STARTS_WITH[key])
        throw denied("Invalid according to Policy: Policy Condition failed")
      if (!holds) throw denied("Invalid according to Policy: Policy Condition failed")
    } else if (key.startsWith("$x-amz-") && !holds)
      throw denied(
        `Invalid according to Policy: Policy Condition failed: [${operator}, ${key}, ${value}]`,
      )
    mustFind.delete(name)
  }
  if (form.has("Signature")) {
    mustFind.delete("Signature")
    for (const key of mustFind.keys())
      if (key.toLowerCase() === "awsaccesskeyid") {
        mustFind.delete(key)
        break
      }
  }
  if (mustFind.size)
    throw denied(
      `Each form field that you specify in a form must appear in the list of policy conditions. ${JSON.stringify([...mustFind.keys()].join(", "))} not specified in the policy.`,
    )
}

/** MinIO's `doesPolicySignatureMatch` (V2 when a `Signature` field is present, else V4). */
const checkSignature = async (ctx: Ctx, form: FormValues) => {
  const { credentials, region } = ctx.core.options
  const lookup = (accessKey: string) =>
    Object.hasOwn(credentials, accessKey) ? credentials[accessKey] : undefined
  const policy = form.get("Policy")
  if (form.has("Signature")) {
    const secret = checkKey(lookup, form.get("AWSAccessKeyId"))
    const expected = btoa(
      String.fromCharCode(...(await hmacRaw("SHA-1", encoder.encode(secret), policy))),
    )
    const given = form.get("Signature")
    let same = false
    try {
      same = atob(given) === atob(expected)
    } catch {}
    if (!same) fail("SignatureDoesNotMatch")
    return
  }
  const credential = parseCredential(`Credential=${form.get("X-Amz-Credential")}`, region)
  const secret = checkKey(lookup, credential.accessKey)
  const key = await signingKey(secret, credential.date, credential.region)
  if (hex(await hmac256(key, policy)) !== form.get("X-Amz-Signature")) fail("SignatureDoesNotMatch")
}

/** Go's `url.QueryEscape`. */
const queryEscape = (value: string) =>
  [...encoder.encode(value)]
    .map((byte) => {
      const char = String.fromCharCode(byte)
      if (/[A-Za-z0-9\-_.~]/.test(char)) return char
      if (char === " ") return "+"
      return `%${byte.toString(16).toUpperCase().padStart(2, "0")}`
    })
    .join("")

/** Go's `URL.EscapedPath` for a plain path. */
const escapePath = (path: string) =>
  [...encoder.encode(path)]
    .map((byte) => {
      const char = String.fromCharCode(byte)
      if (/[A-Za-z0-9\-_.~$&+,/:;=@]/.test(char)) return char
      return `%${byte.toString(16).toUpperCase().padStart(2, "0")}`
    })
    .join("")

/** `success_action_redirect` with `bucket`, `key` and `etag` added (Go's sorted `Encode`). */
const redirectLocation = (target: string, bucket: string, key: string, etag: string) => {
  const hash = target.indexOf("#")
  const fragment = hash < 0 ? "" : target.slice(hash)
  const withoutFragment = hash < 0 ? target : target.slice(0, hash)
  const question = withoutFragment.indexOf("?")
  const base = question < 0 ? withoutFragment : withoutFragment.slice(0, question)
  const pairs: [string, string][] = []
  if (question >= 0)
    for (const pair of withoutFragment.slice(question + 1).split("&")) {
      if (!pair) continue
      const equals = pair.indexOf("=")
      const decode = (value: string) => {
        try {
          return decodeURIComponent(value.replace(/\+/g, " "))
        } catch {
          return value
        }
      }
      pairs.push(
        equals < 0
          ? [decode(pair), ""]
          : [decode(pair.slice(0, equals)), decode(pair.slice(equals + 1))],
      )
    }
  pairs.push(["bucket", bucket], ["key", key], ["etag", `"${etag}"`])
  const names = [...new Set(pairs.map(([name]) => name))].sort()
  const query = names
    .flatMap((name) =>
      pairs
        .filter(([n]) => n === name)
        .map(([, value]) => `${queryEscape(name)}=${queryEscape(value)}`),
    )
    .join("&")
  return `${base}?${query}${fragment}`
}

/** The `tagging` field (`<Tagging><TagSet><Tag>...`) as a URL-encoded tag set. */
const parseTagging = (xml: string) => {
  const body =
    /^\s*(?:<\?xml[^>]*\?>\s*)?<Tagging(?:\s[^>]*)?>\s*<TagSet>([\s\S]*)<\/TagSet>\s*<\/Tagging>\s*$/.exec(
      xml,
    )
  if (!body) throw new S3Error("MalformedPOSTRequest")
  const tags: [string, string][] = []
  const rest = (body[1] as string).replace(
    /<Tag>\s*<Key>([^<]*)<\/Key>\s*<Value>([^<]*)<\/Value>\s*<\/Tag>/g,
    (_, key: string, value: string) => {
      tags.push([key, value])
      return ""
    },
  )
  if (rest.trim() || tags.length > 10 || new Set(tags.map(([key]) => key)).size !== tags.length)
    throw new S3Error("MalformedPOSTRequest")
  return tags
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${queryEscape(key)}=${queryEscape(value)}`)
    .join("&")
}

/** The key placeholder S3 replaces with the uploaded file's name. */
// biome-ignore lint/suspicious/noTemplateCurlyInString: a literal S3 placeholder, not a template.
const FILENAME_VARIABLE = "${filename}"

const SYSTEM_FIELDS = [
  "Content-Type",
  "Cache-Control",
  "Content-Language",
  "Content-Encoding",
  "Content-Disposition",
]

export const postHandlers: Handlers = {
  async PostObject(ctx) {
    const headers = ctx.headers
    if (headers.get("x-amz-server-side-encryption") === "aws:kms") fail("NotImplemented")
    // The route matches any path under the bucket; only the bucket itself takes a form.
    if (ctx.key.replace(/\/+$/, "") !== "") fail("MethodNotAllowed", { key: "" })
    if (Number(headers.get("content-length") ?? "0") <= 0) fail("EmptyRequestBody")
    const media = mediaParams(headers.get("content-type") ?? "")
    if (!media.type.startsWith("multipart/"))
      throw malformed("request Content-Type isn't multipart/form-data")
    const boundary = media.params.get("boundary")
    if (!boundary) throw malformed("no multipart boundary param in Content-Type")
    const body = await ctx.body()

    const form = new FormValues()
    let file: Uint8Array | undefined
    let fileName = ""
    for (const part of multipartParts(body, boundary)) {
      if (!part.name) continue
      fileName = part.filename
      if (part.body === undefined) continue
      if (part.name !== "file") {
        form.add(part.name, utf8.decode(part.body))
        continue
      }
      file = part.body
      break
    }
    if (!file) throw malformed("The file or text content is missing")
    if (!form.has("Key")) throw malformed("The name of the uploaded key is missing")
    if (fileName === "") fileName = form.get("Key")
    if (fileName === "") throw malformed("The file or text content is missing")
    form.set("Bucket", ctx.bucket)
    if (form.get("Key").includes(FILENAME_VARIABLE))
      form.set("Key", form.get("Key").replaceAll(FILENAME_VARIABLE, fileName))
    const object = form.get("Key").replace(/^\/+/, "")
    const redirect = form.get("success_action_redirect")
    const status = form.get("success_action_status")
    // biome-ignore lint/suspicious/noControlCharactersInRegex: Go's url.Parse refuses control bytes.
    if (redirect && /%(?![0-9A-Fa-f]{2})|[\x00-\x1f\x7f ]/.test(redirect))
      fail("MalformedPOSTRequest")

    await checkSignature(ctx, form)
    const policyText = form.get("Policy")
    if (
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
        policyText.replace(/[\r\n]/g, ""),
      )
    )
      fail("MalformedPOSTRequest")
    const policyBytes = latin1Bytes(atob(policyText.replace(/[\r\n]/g, "")))
    const md5 = form.has("Content-Md5") ? form.get("Content-Md5") : undefined
    if (md5 !== undefined) {
      const valid =
        /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(md5) && md5 !== ""
      if (!valid || atob(md5).length !== 16) fail("InvalidDigest")
    }
    let length: PostPolicy["length"]
    if (policyBytes.length) {
      const policy = parsePolicy(utf8.decode(policyBytes))
      checkPolicy(form, policy, ctx.now)
      length = policy.length
    }
    let tagging: string | undefined
    if (form.get("Tagging")) tagging = parseTagging(form.get("Tagging"))

    requireBucket(ctx)
    // hash.Reader at EOF: the MD5, then the content-length-range.
    if (md5 !== undefined && md5Base64(file) !== md5) fail("BadDigest")
    if (length && length.min > 0 && file.length < length.min) fail("EntityTooSmall")
    if (length && length.max > 0 && file.length > length.max) fail("EntityTooLarge")

    const metadata: Record<string, string> = {}
    for (const [name, values] of form.values) {
      const lower = name.toLowerCase()
      if (lower.startsWith("x-amz-meta-"))
        metadata[lower.slice("x-amz-meta-".length)] = asHeaderValue(values.join(","))
    }
    const system = (name: string) =>
      form.has(name) ? asHeaderValue(form.values.get(canonical(name))?.join(",") ?? "") : undefined
    const [contentType, cacheControl, contentLanguage, contentEncoding, contentDisposition] =
      SYSTEM_FIELDS.map(system)
    const version = ctx.core.write(
      {
        bucket: ctx.bucket,
        key: object,
        etag: md5Hex(file),
        lastModified: ctx.now,
        metadata,
        contentType: contentType || typeByExtension(object),
        ...(cacheControl ? { cacheControl } : {}),
        ...(contentLanguage ? { contentLanguage } : {}),
        ...(contentEncoding ? { contentEncoding } : {}),
        ...(contentDisposition ? { contentDisposition } : {}),
        ...(tagging ? { tagging } : {}),
      },
      file,
    )
    ctx.core.notify({
      eventName: "ObjectCreated:Post",
      bucket: ctx.bucket,
      key: object,
      etag: version.etag,
      size: version.size,
      ...(version.versionId !== "null" ? { versionId: version.versionId } : {}),
    })
    const location = `${ctx.url.protocol}//${ctx.url.host}${escapePath(`/${ctx.bucket}/${object}`.replace(/\/+$/, "") || "/")}`
    const common: Record<string, string> = {
      etag: `"${version.etag}"`,
      ...(version.versionId !== "null" ? { "x-amz-version-id": version.versionId } : {}),
      location,
    }
    if (redirect)
      return ok(
        { ...common, location: redirectLocation(redirect, ctx.bucket, object, version.etag) },
        303,
      )
    if (status === "201")
      return xmlResponse(
        "PostResponse",
        el("Bucket", ctx.bucket) +
          el("Key", object) +
          el("ETag", `"${version.etag}"`) +
          el("Location", location),
        { status: 201, headers: common, xmlns: false },
      )
    if (status === "200") return ok(common, 200)
    return new Response(null, { status: 204, headers: common })
  },
}
