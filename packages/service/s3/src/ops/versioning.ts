/** Bucket versioning: PutBucketVersioning, GetBucketVersioning (with MinIO's prefix extensions). */
import { type Handlers, ok } from "../context.js"
import { fail, S3Error } from "../errors.js"
import { child, children, decodeGoXml, GoXmlError, goBool } from "../goxml.js"
import type { BucketRecord, VersioningStatus } from "../state.js"
import { el, esc, S3_XMLNS, wrap } from "../xml.js"
import { requireBucket } from "./common.js"

const CONFIG = "versioning"
const MAX_EXCLUDED_PREFIXES = 10

type Versioning = {
  xmlns: string
  status: string
  excludedPrefixes: string[]
  excludeFolders: boolean
}

const illegal = (detail: string) =>
  new S3Error("InvalidArgument", {
    code: "IllegalVersioningConfigurationException",
    message: `Versioning configuration specified in the request is invalid. (${detail})`,
  })

/**
 * An `encoding/xml` failure as MinIO's `toAPIError` reports it: syntax errors are MalformedXML,
 * anything else (io.EOF, unmarshal errors) an InternalError carrying the cause.
 */
export const goXmlApiError = (error: GoXmlError) =>
  error.kind === "syntax"
    ? new S3Error("MalformedXML", {
        message: `The XML you provided was not well-formed or did not validate against our published schema. (${error.message})`,
      })
    : new S3Error("InternalError", {
        message: `We encountered an internal error, please try again.: cause(${error.message})`,
      })

/** `versioning.ParseConfig`. */
const parse = (body: string): Versioning => {
  let config: Versioning
  try {
    const root = decodeGoXml(body, "VersioningConfiguration")
    config = {
      xmlns: root.attrs.xmlns ?? "",
      status: child(root, "Status")?.text ?? "",
      excludedPrefixes: children(root, "ExcludedPrefixes").map(
        (item) => child(item, "Prefix")?.text ?? "",
      ),
      excludeFolders: (() => {
        const node = child(root, "ExcludeFolders")
        return node ? goBool(node) : false
      })(),
    }
  } catch (error) {
    if (error instanceof GoXmlError) throw goXmlApiError(error)
    throw error
  }
  switch (config.status) {
    case "Enabled":
      if (config.excludedPrefixes.length > MAX_EXCLUDED_PREFIXES)
        throw illegal("too many excluded prefixes")
      break
    case "Suspended":
      if (config.excludedPrefixes.length > 0)
        throw illegal("excluded prefixes extension supported only when versioning is enabled")
      break
    default:
      throw illegal(`unsupported Versioning status ${config.status}`)
  }
  return config
}

/**
 * A stored bucket configuration as MinIO returns it: `xml.Marshal` output written as is, so no
 * `<?xml?>` header (unlike `encodeResponse` bodies).
 */
export const bareXml = (root: string, children: string, xmlns: string) =>
  new Response(`<${root}${xmlns ? ` xmlns="${esc(xmlns)}"` : ""}>${children}</${root}>`, {
    headers: { "content-type": "application/xml" },
  })

/** The configuration as MinIO re-marshals and stores it. */
const render = (config: Versioning) =>
  el("Status", config.status) +
  config.excludedPrefixes.map((prefix) => wrap("ExcludedPrefixes", el("Prefix", prefix))).join("") +
  (config.excludeFolders ? el("ExcludeFolders", "true") : "")

export const versioningHandlers: Handlers = {
  async PutBucketVersioning(ctx) {
    const config = parse(await ctx.text())
    const record = ctx.core.bucket(ctx.bucket)
    const prefixesExcluded = config.excludedPrefixes.length > 0 || config.excludeFolders
    if (record?.objectLock && (config.status === "Suspended" || prefixesExcluded))
      fail("InvalidArgument", {
        code: "InvalidBucketState",
        message:
          "An Object Lock configuration is present on this bucket, versioning cannot be suspended.",
      })
    // MinIO answers 200 for a bucket that does not exist (its metadata update does not check).
    if (!record) return ok()
    const next: BucketRecord = { ...record, versioning: config.status as VersioningStatus }
    delete next.versioningExcludedPrefixes
    delete next.versioningExcludeFolders
    if (config.excludedPrefixes.length) next.versioningExcludedPrefixes = config.excludedPrefixes
    if (config.excludeFolders) next.versioningExcludeFolders = true
    ctx.core.saveBucket(ctx.bucket, next)
    ctx.core.setConfig(ctx.bucket, CONFIG, JSON.stringify(config))
    return ok()
  },
  GetBucketVersioning(ctx) {
    const record = requireBucket(ctx)
    const stored = ctx.core.config(ctx.bucket, CONFIG)
    if (stored) {
      const config = JSON.parse(stored) as Versioning
      return bareXml("VersioningConfiguration", render(config), config.xmlns)
    }
    // Buckets created with object lock start Enabled without a stored document.
    return bareXml(
      "VersioningConfiguration",
      record.versioning ? el("Status", record.versioning) : "",
      S3_XMLNS,
    )
  },
}
