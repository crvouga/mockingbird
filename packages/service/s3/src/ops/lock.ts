/**
 * Object lock (MinIO's `cmd/bucket-object-lock.go` and `internal/bucket/object/lock`):
 * PutObjectLockConfiguration, GetObjectLockConfiguration, Put/GetObjectRetention,
 * Put/GetObjectLegalHold, plus the rules other operations share — `objectLockForWrite` for the
 * `x-amz-object-lock-*` headers of a new version and `checkDeleteAllowed` for deleting one.
 */
import { type Ctx, type Handlers, ok, xmlResponse } from "../context.js"
import { md5Hex } from "../digest.js"
import { fail, S3Error } from "../errors.js"
import { child, decodeGoXml, GoXmlError, goUint } from "../goxml.js"
import type { BucketRecord, ObjectVersion } from "../state.js"
import type { S3Core } from "../store.js"
import { el, S3_XMLNS, wrap } from "../xml.js"
import { requestVersionId } from "./common.js"
import { bareXml } from "./versioning.js"

type Mode = "GOVERNANCE" | "COMPLIANCE"
type Rule = NonNullable<BucketRecord["defaultRetention"]>
type LockConfig = { xmlns: string; rule?: Rule }

const CONFIG = "object-lock"
const MAX_DAYS = 36500
const MAX_YEARS = 100

const isMode = (value: string): value is Mode => value === "GOVERNANCE" || value === "COMPLIANCE"

// ── dates ──────────────────────────────────────────────────────────────────

const DATE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$/

/** `amztime.ISO8601Parse`: `...00.000Z`, `...00.000000Z` or RFC 3339; epoch ms or undefined. */
export const parseLockDate = (value: string): number | undefined => {
  const match = DATE.exec(value)
  if (!match) return undefined
  const [, y, mo, d, h, mi, s, frac, zone] = match as unknown as string[]
  const year = Number(y)
  const month = Number(mo)
  const day = Number(d)
  if (month < 1 || month > 12 || day < 1) return undefined
  if (day > new Date(Date.UTC(year, month, 0)).getUTCDate()) return undefined
  if (Number(h) > 23 || Number(mi) > 59 || Number(s) > 59) return undefined
  const ms = frac ? Number((frac as string).slice(0, 3).padEnd(3, "0")) : 0
  let at = Date.UTC(year, month - 1, day, Number(h), Number(mi), Number(s), ms)
  if (year < 100) at = new Date(at).setUTCFullYear(year)
  if (zone !== "Z") {
    const sign = (zone as string).startsWith("-") ? -1 : 1
    const [zh, zm] = (zone as string).slice(1).split(":").map(Number)
    if ((zh as number) > 23 || (zm as number) > 59) return undefined
    at -= sign * ((zh as number) * 60 + (zm as number)) * 60_000
  }
  return at
}

/** `amztime.ISO8601Format`: UTC with milliseconds. */
export const formatLockDate = (ms: number) => new Date(ms).toISOString()

// ── request bodies ────────────────────────────────────────────────────────

/** MinIO's `validateLengthAndChecksum`: a decodable Content-MD5 or an `x-amz-checksum-*`. */
export const hasContentChecksum = (headers: Headers) => {
  const md5 = headers.get("content-md5")
  if (md5) return /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(md5)
  for (const name of ["crc32", "crc32c", "crc64nvme", "sha1", "sha256"])
    if (headers.get(`x-amz-checksum-${name}`)) return true
  return /^x-amz-checksum-/i.test(headers.get("x-amz-trailer") ?? "")
}

/**
 * The body of a request whose handler parses XML without reading to EOF, so MinIO never
 * notices a wrong Content-MD5: the bytes as sent, and whether the MD5 matched.
 */
export const lenientBody = async (ctx: Ctx): Promise<{ text: string; md5Mismatch: boolean }> => {
  const copy = ctx.request.clone()
  try {
    return { text: await ctx.text(), md5Mismatch: false }
  } catch (error) {
    if (!(error instanceof S3Error) || error.errorName !== "BadDigest") throw error
    return { text: await copy.text(), md5Mismatch: true }
  }
}

const base64Hex = (value: string) =>
  [...atob(value)].map((char) => char.charCodeAt(0).toString(16).padStart(2, "0")).join("")

// ── bucket configuration ──────────────────────────────────────────────────

const configError = (message: string) => new S3Error("InvalidArgument", { message })

/** `objectlock.ParseObjectLockConfig`; every failure is InvalidArgument with Go's message. */
const parseConfig = (body: string): { config: LockConfig; ruleWithoutRetention: boolean } => {
  let root: ReturnType<typeof decodeGoXml>
  let rule: Rule | undefined
  let ruleWithoutRetention = false
  try {
    root = decodeGoXml(body, "ObjectLockConfiguration")
    const ruleNode = child(root, "Rule")
    if (ruleNode) {
      const retention = child(ruleNode, "DefaultRetention")
      if (!retention) ruleWithoutRetention = true
      else {
        const daysNode = child(retention, "Days")
        const yearsNode = child(retention, "Years")
        const days = daysNode ? goUint(daysNode) : undefined
        const years = yearsNode ? goUint(yearsNode) : undefined
        const mode = child(retention, "Mode")?.text ?? ""
        if (!isMode(mode)) throw configError(`unknown retention mode ${mode}`)
        if (days === undefined && years === undefined)
          throw configError("either Days or Years must be specified")
        if (days !== undefined && years !== undefined)
          throw configError("either Days or Years must be specified, not both")
        if (days !== undefined) {
          if (days === 0)
            throw configError(
              "Default retention period must be a positive integer value for 'Days'",
            )
          if (days > MAX_DAYS)
            throw configError(`Default retention period too large for 'Days' ${days}`)
        } else if (years === 0)
          throw configError("Default retention period must be a positive integer value for 'Years'")
        else if ((years as number) > MAX_YEARS)
          throw configError(`Default retention period too large for 'Years' ${years}`)
        rule = { mode, ...(days !== undefined ? { days } : { years: years as number }) }
      }
    }
  } catch (error) {
    if (error instanceof GoXmlError) throw configError(error.message)
    throw error
  }
  if (child(root, "ObjectLockEnabled")?.text !== "Enabled")
    throw configError("only 'Enabled' value is allowed to ObjectLockEnabled element")
  return {
    config: { xmlns: root.attrs.xmlns ?? "", ...(rule ? { rule } : {}) },
    ruleWithoutRetention,
  }
}

const renderConfig = (config: LockConfig) =>
  el("ObjectLockEnabled", "Enabled") +
  (config.rule
    ? wrap(
        "Rule",
        wrap(
          "DefaultRetention",
          el("Mode", config.rule.mode) +
            el("Days", config.rule.days) +
            el("Years", config.rule.years),
        ),
      )
    : "")

// ── object retention and legal hold ───────────────────────────────────────

type Retention = NonNullable<ObjectVersion["retention"]>

/** `objectlock.ParseObjectRetention`; failures are MalformedXML with Go's message. */
const parseRetention = (body: string, now: number): Retention | undefined => {
  const malformed = (message: string) => new S3Error("MalformedXML", { message })
  let mode: string
  let until: number | undefined
  try {
    const root = decodeGoXml(body, "Retention")
    mode = child(root, "Mode")?.text ?? ""
    const date = child(root, "RetainUntilDate")
    if (date) {
      until = parseLockDate(date.text)
      if (until === undefined) throw malformed("date must be provided in ISO 8601 format")
    }
  } catch (error) {
    if (error instanceof GoXmlError) throw malformed(error.message)
    throw error
  }
  const schema =
    "the XML you provided was not well-formed or did not validate against our published schema"
  if (mode !== "" && !isMode(mode)) throw malformed("unknown WORM mode directive")
  if (isMode(mode) && until === undefined) throw malformed(schema)
  if (!isMode(mode) && until !== undefined) throw malformed(schema)
  if (until !== undefined && until < now)
    throw malformed("the retain until date must be in the future")
  return isMode(mode) ? { mode, until: formatLockDate(until as number) } : undefined
}

/** `objectlock.ParseObjectLegalHold`. */
const parseLegalHold = (body: string): "ON" | "OFF" => {
  const malformed = (message: string) => new S3Error("MalformedXML", { message })
  let status = ""
  try {
    const root = decodeGoXml(body)
    if (root.name !== "LegalHold" && root.name !== "ObjectLockLegalHold")
      throw new GoXmlError(
        "unmarshal",
        `expected element type <LegalHold>/<ObjectLockLegalHold> but have <${root.name}>`,
      )
    for (const item of root.children) {
      if (item.name !== "Status")
        throw new GoXmlError("unmarshal", `expected element type <Status> but have <${item.name}>`)
      status = item.text
    }
  } catch (error) {
    if (error instanceof GoXmlError) throw malformed(error.message)
    throw error
  }
  if (status !== "ON" && status !== "OFF")
    throw malformed(
      "the XML you provided was not well-formed or did not validate against our published schema",
    )
  return status
}

/** Governance bypass requested (`x-amz-bypass-governance-retention: true`, any case). */
const bypassRequested = (headers: Headers) =>
  (headers.get("x-amz-bypass-governance-retention") ?? "").toLowerCase() === "true"

const isLocked = (version: ObjectVersion, now: number, bypass: boolean) => {
  if (version.deleteMarker) return false
  if (version.legalHold === "ON") return true
  const retention = version.retention
  if (!retention) return false
  if (retention.mode === "GOVERNANCE" && bypass) return false
  return Date.parse(retention.until) >= now
}

/**
 * `enforceRetentionBypassForDelete`: deleting `version` (named by id) is ObjectLocked while it
 * is on legal hold or under unexpired retention (governance yields to the bypass header).
 */
export const checkDeleteAllowed = (ctx: Ctx, version: ObjectVersion | undefined) => {
  if (version && isLocked(version, ctx.now, bypassRequested(ctx.headers))) fail("ObjectLocked")
}

/** `enforceRetentionBypassForPut`: may `next` replace the version's current retention? */
const checkRetentionChange = (ctx: Ctx, version: ObjectVersion, next: Retention | undefined) => {
  const current = version.retention
  if (!current) return
  const currentUntil = Date.parse(current.until)
  if (currentUntil < ctx.now) return
  const nextUntil = next ? Date.parse(next.until) : Number.NEGATIVE_INFINITY
  if (current.mode === "GOVERNANCE" && !bypassRequested(ctx.headers)) {
    if (next?.mode !== "GOVERNANCE" || nextUntil < currentUntil) fail("ObjectLocked")
  }
  if (current.mode === "COMPLIANCE" && (next?.mode !== "COMPLIANCE" || nextUntil < currentUntil))
    fail("ObjectLocked")
}

/**
 * `checkPutObjectLockAllowed` for a new version's `x-amz-object-lock-*` headers (PutObject,
 * CopyObject, CreateMultipartUpload, PostObject). Throws MinIO's error for an invalid or
 * misplaced header; otherwise returns the retention / legal hold to store on the version. A
 * version written without either gets the bucket's default retention from `S3Core.write`.
 */
export const objectLockForWrite = (
  core: S3Core,
  bucket: string,
  headers: Headers,
  now: number,
): Pick<ObjectVersion, "retention" | "legalHold"> => {
  const modeHeader = headers.get("x-amz-object-lock-mode")
  const dateHeader = headers.get("x-amz-object-lock-retain-until-date")
  const holdHeader = headers.get("x-amz-object-lock-legal-hold")
  const retentionRequested = modeHeader !== null || dateHeader !== null
  const holdRequested = holdHeader !== null
  if (!core.bucket(bucket)?.objectLock) {
    if (retentionRequested || holdRequested) fail("InvalidBucketObjectLockConfiguration")
    return {}
  }
  const out: Pick<ObjectVersion, "retention" | "legalHold"> = {}
  if (holdRequested) {
    const status = (holdHeader as string).toUpperCase()
    if (status !== "ON" && status !== "OFF") fail("UnknownWORMModeDirective")
    out.legalHold = status as "ON" | "OFF"
  }
  if (retentionRequested) {
    if (!modeHeader || !dateHeader) fail("ObjectLockInvalidHeaders")
    const mode = (modeHeader as string).toUpperCase()
    if (!isMode(mode)) fail("UnknownWORMModeDirective")
    const until = parseLockDate(dateHeader as string)
    if (until === undefined) fail("InvalidRetentionDate")
    if ((until as number) < now) fail("PastObjectLockRetainDate")
    out.retention = { mode: mode as Mode, until: formatLockDate(until as number) }
  }
  return out
}

/**
 * The version a retention / legal-hold request names, as MinIO's `PutObjectMetadata` and
 * `GetObjectInfo` find it. A delete marker is MethodNotAllowed for a PUT; for a GET the latest
 * one is NoSuchKey and one named by id MethodNotAllowed.
 */
const lockTarget = (ctx: Ctx, put: boolean): ObjectVersion => {
  const versionId = requestVersionId(ctx)
  const found = versionId
    ? ctx.core.version(ctx.bucket, ctx.key, versionId)
    : ctx.core.head(ctx.bucket, ctx.key)
  if (!found) fail(versionId ? "NoSuchVersion" : "NoSuchKey")
  const version = found as ObjectVersion
  if (version.deleteMarker) fail(put || versionId ? "MethodNotAllowed" : "NoSuchKey")
  return version
}

const requireLockBucket = (ctx: Ctx) => {
  if (!ctx.core.bucket(ctx.bucket)?.objectLock) fail("InvalidBucketObjectLockConfiguration")
}

export const lockHandlers: Handlers = {
  async PutObjectLockConfiguration(ctx) {
    const { config, ruleWithoutRetention } = parseConfig(await ctx.text())
    const record = ctx.core.bucket(ctx.bucket)
    if (!record?.objectLock) fail("ObjectLockConfigurationNotAllowed")
    if (ruleWithoutRetention)
      fail("InternalError", {
        message:
          "We encountered an internal error, please try again.: cause(unknown retention mode )",
      })
    const next: BucketRecord = { ...(record as BucketRecord) }
    delete next.defaultRetention
    if (config.rule) next.defaultRetention = config.rule
    ctx.core.saveBucket(ctx.bucket, next)
    ctx.core.setConfig(ctx.bucket, CONFIG, JSON.stringify(config))
    return ok()
  },
  GetObjectLockConfiguration(ctx) {
    if (!ctx.core.bucket(ctx.bucket)?.objectLock) fail("ObjectLockConfigurationNotFound")
    const stored = ctx.core.config(ctx.bucket, CONFIG)
    const config: LockConfig = stored ? JSON.parse(stored) : { xmlns: S3_XMLNS }
    return bareXml("ObjectLockConfiguration", renderConfig(config), config.xmlns)
  },
  async PutObjectRetention(ctx) {
    ctx.core.requireBucket(ctx.bucket)
    if (!hasContentChecksum(ctx.headers)) fail("MissingContentMD5")
    requireLockBucket(ctx)
    const { text } = await lenientBody(ctx)
    const retention = parseRetention(text, ctx.now)
    const version = lockTarget(ctx, true)
    checkRetentionChange(ctx, version, retention)
    const next: ObjectVersion = { ...version }
    delete next.retention
    if (retention) next.retention = retention
    ctx.core.update(next)
    return ok()
  },
  GetObjectRetention(ctx) {
    requireLockBucket(ctx)
    const version = lockTarget(ctx, false)
    if (!version.retention) fail("NoSuchObjectLockConfiguration")
    const retention = version.retention as Retention
    return xmlResponse(
      "Retention",
      el("Mode", retention.mode) + el("RetainUntilDate", retention.until),
    )
  },
  async PutObjectLegalHold(ctx) {
    ctx.core.requireBucket(ctx.bucket)
    if (!hasContentChecksum(ctx.headers)) fail("MissingContentMD5")
    requireLockBucket(ctx)
    const { text, md5Mismatch } = await lenientBody(ctx)
    // ParseObjectLegalHold reads the whole body, so MinIO's MD5 check fires (as MalformedXML).
    if (md5Mismatch)
      fail("MalformedXML", {
        message: `Bad digest: Expected ${base64Hex(ctx.headers.get("content-md5") ?? "")} does not match calculated ${md5Hex(new TextEncoder().encode(text))}`,
      })
    const status = parseLegalHold(text)
    const version = lockTarget(ctx, true)
    ctx.core.update({ ...version, legalHold: status })
    return ok()
  },
  GetObjectLegalHold(ctx) {
    requireLockBucket(ctx)
    const version = lockTarget(ctx, false)
    if (!version.legalHold) fail("NoSuchObjectLockConfiguration")
    return xmlResponse("LegalHold", el("Status", version.legalHold))
  },
}
