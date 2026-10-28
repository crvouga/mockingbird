/**
 * ACLs, as MinIO's dummies (`acl-handlers.go`): GetBucketAcl/GetObjectAcl answer one fixed
 * FULL_CONTROL grant; PutBucketAcl/PutObjectAcl accept the `private` canned ACL, or (without
 * `x-amz-acl`) a body whose first grant is FULL_CONTROL, and are NotImplemented otherwise.
 * The handlers authorize with no object name, so their errors carry no `<Key>`; their success
 * responses are written straight to the connection (no `Accept-Ranges` / bucket region).
 */
import { GoError, parseGoXml } from "../bucket-config/goxml.js"
import type { Ctx, Handlers } from "../context.js"
import { fail, S3Error, type S3ErrorOptions } from "../errors.js"

const ACL =
  '<AccessControlPolicy><Owner><ID></ID><DisplayName></DisplayName></Owner><AccessControlList><Grant><Grantee xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:type="CanonicalUser"><Type>CanonicalUser</Type></Grantee><Permission>FULL_CONTROL</Permission></Grant></AccessControlList></AccessControlPolicy>'

const NO_KEY: S3ErrorOptions = { key: "" }
const STREAMED = { "x-mockingbird-s3-unrouted": "streamed" }

const requireTarget = (ctx: Ctx) => {
  try {
    ctx.core.requireBucket(ctx.bucket)
    if (!ctx.key) return
    const head = ctx.core.head(ctx.bucket, ctx.key)
    if (!head || head.deleteMarker) fail("NoSuchKey")
  } catch (error) {
    if (error instanceof S3Error)
      throw new S3Error(error.errorName, { ...error.options, ...NO_KEY })
    throw error
  }
}

const notImplemented = (): never =>
  fail("NotImplemented", { ...NO_KEY, message: `${new S3Error("NotImplemented").message} ()` })

const getAcl = (ctx: Ctx) => {
  requireTarget(ctx)
  return new Response(ACL, {
    status: 200,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "content-length": String(ACL.length),
      ...STREAMED,
    },
  })
}

const putAcl = async (ctx: Ctx) => {
  requireTarget(ctx)
  const canned = ctx.headers.get("x-amz-acl") ?? ""
  if (canned === "") {
    const body = await ctx.text()
    let permission: string | undefined
    let grants = 0
    try {
      const root = parseGoXml(body)
      if (root.name !== "AccessControlPolicy")
        throw new GoError(
          "unmarshal",
          `expected element type <AccessControlPolicy> but have <${root.name}>`,
        )
      for (const list of root.children)
        if (list.name === "AccessControlList")
          for (const grant of list.children)
            if (grant.name === "Grant") {
              if (grants === 0)
                permission =
                  grant.children.filter((child) => child.name === "Permission").at(-1)?.text ?? ""
              grants++
            }
    } catch (error) {
      if (!(error instanceof GoError)) throw error
      // `xmlDecoder` turns io.EOF into a line-0 SyntaxError; PutBucketACL answers it plainly.
      if (error.kind === "eof" && !ctx.key) fail("MalformedXML", NO_KEY)
      if (error.kind === "syntax" || error.kind === "eof")
        fail("MalformedXML", {
          ...NO_KEY,
          message: `${new S3Error("MalformedXML").message} (${error.kind === "eof" ? "XML syntax error on line 0: EOF" : error.message})`,
        })
      fail("InternalError", {
        ...NO_KEY,
        message: `${new S3Error("InternalError").message}: cause(${error.message})`,
      })
    }
    if (grants === 0 || permission !== "FULL_CONTROL") notImplemented()
  }
  if (canned !== "" && canned !== "private") notImplemented()
  return new Response(null, { status: 200, headers: { "content-length": "0", ...STREAMED } })
}

export const aclHandlers: Handlers = {
  GetBucketAcl: getAcl,
  GetObjectAcl: getAcl,
  PutBucketAcl: putAcl,
  PutObjectAcl: putAcl,
}
