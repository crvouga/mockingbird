/**
 * Browser POST uploads (`PostPolicyBucketHandler`): a `multipart/form-data` form whose base64
 * JSON policy is signed (SigV4 or SigV2), its conditions, and every success and error answer.
 */
import { createHash, createHmac } from "node:crypto"
import { type Ctx, keyPath, type Scenario } from "../harness.js"

// biome-ignore lint/suspicious/noTemplateCurlyInString: S3's literal key placeholder.
const FILENAME = "${filename}"
const BOUNDARY = "----mockingbird-form-boundary"
const FUTURE = "2100-01-01T00:00:00.000Z"
const md5 = (value: string) => createHash("md5").update(value).digest("base64")

type Field = [string, string]
type File = { content: string; filename?: string; type?: string; field?: string }

/** A multipart/form-data body: fields in order, then the file (unless `null`), then more fields. */
const formBody = (fields: Field[], file: File | null, after: Field[] = []) => {
  const part = (headers: string, value: string) => `--${BOUNDARY}\r\n${headers}\r\n\r\n${value}\r\n`
  let body = fields
    .map(([name, value]) => part(`Content-Disposition: form-data; name="${name}"`, value))
    .join("")
  if (file) {
    const disposition = `Content-Disposition: form-data; name="${file.field ?? "file"}"${file.filename !== undefined ? `; filename="${file.filename}"` : ""}`
    body += part(
      file.type ? `${disposition}\r\nContent-Type: ${file.type}` : disposition,
      file.content,
    )
  }
  body += after
    .map(([name, value]) => part(`Content-Disposition: form-data; name="${name}"`, value))
    .join("")
  return `${body}--${BOUNDARY}--\r\n`
}

const hmac = (key: string | Buffer, data: string) => createHmac("sha256", key).update(data).digest()
const amzDate = (date: Date) => date.toISOString().replace(/[:-]|\.\d{3}/g, "")

type FormOptions = {
  /** Extra policy conditions, after the standard ones. */
  conditions?: unknown[]
  /** Replace the standard conditions entirely. */
  only?: unknown[]
  expiration?: string
  /** Form fields besides the auth ones, before the file. */
  fields?: Field[]
  after?: Field[]
  file?: File | null
  /** A raw policy document instead of the JSON one. */
  policy?: string
  /** Leave these auth fields out. */
  omit?: string[]
  /** Override auth field values after signing. */
  override?: Record<string, string>
  credentials?: { accessKey: string; secretKey: string }
  region?: string
  /** Sign with SigV2 (`AWSAccessKeyId` + `Signature`) instead of SigV4. */
  v2?: boolean
  key?: string
}

/** A signed POST policy form for bucket `b`. */
const signedForm = (s: Ctx, b: string, options: FormOptions = {}) => {
  const accessKey = options.credentials?.accessKey ?? s.target.accessKey
  const secretKey = options.credentials?.secretKey ?? s.target.secretKey
  const region = options.region ?? s.target.region
  const now = new Date()
  const stamp = amzDate(now)
  const day = stamp.slice(0, 8)
  const credential = `${accessKey}/${day}/${region}/s3/aws4_request`
  const authConditions = options.v2
    ? []
    : [
        { "x-amz-algorithm": "AWS4-HMAC-SHA256" },
        { "x-amz-credential": credential },
        { "x-amz-date": stamp },
      ]
  const conditions = options.only ?? [
    { bucket: b },
    ["starts-with", "$key", ""],
    ...authConditions,
    ...(options.conditions ?? []),
  ]
  const policy =
    options.policy ??
    Buffer.from(JSON.stringify({ expiration: options.expiration ?? FUTURE, conditions })).toString(
      "base64",
    )
  const auth: Field[] = options.v2
    ? [
        ["AWSAccessKeyId", accessKey],
        ["policy", policy],
        ["signature", createHmac("sha1", secretKey).update(policy).digest("base64")],
      ]
    : [
        ["x-amz-algorithm", "AWS4-HMAC-SHA256"],
        ["x-amz-credential", credential],
        ["x-amz-date", stamp],
        ["policy", policy],
        [
          "x-amz-signature",
          hmac(
            hmac(hmac(hmac(hmac(`AWS4${secretKey}`, day), region), "s3"), "aws4_request"),
            policy,
          ).toString("hex"),
        ],
      ]
  const fields: Field[] = [
    ...(options.key === undefined
      ? [["key", "upload.txt"] as Field]
      : options.key === ""
        ? []
        : [["key", options.key] as Field]),
    ...(options.fields ?? []),
    ...auth
      .filter(([name]) => !options.omit?.includes(name))
      .map(([name, value]) => [name, options.override?.[name] ?? value] as Field),
  ]
  return formBody(
    fields,
    options.file === undefined
      ? { content: "posted content", filename: "local.txt" }
      : options.file,
    options.after,
  )
}

const post = (s: Ctx, step: string, b: string, body: string, path = keyPath(b)) =>
  s.req(step, {
    method: "POST",
    path,
    auth: "anonymous",
    headers: { "content-type": `multipart/form-data; boundary=${BOUNDARY}` },
    body,
  })

export const scenarios: Scenario[] = [
  {
    name: "success-statuses",
    async run(s) {
      const b = await s.bucket("post-ok")
      await post(s, "default 204", b, signedForm(s, b))
      await s.req("get", { method: "GET", path: keyPath(b, "upload.txt") })
      await post(
        s,
        "status 200",
        b,
        signedForm(s, b, {
          key: "two.txt",
          fields: [["success_action_status", "200"]],
          conditions: [{ success_action_status: "200" }],
        }),
      )
      await post(
        s,
        "status 201",
        b,
        signedForm(s, b, {
          key: "dir/three ü.txt",
          fields: [["success_action_status", "201"]],
          conditions: [{ success_action_status: "201" }],
        }),
      )
      await post(
        s,
        "status 204",
        b,
        signedForm(s, b, {
          key: "four.txt",
          fields: [["success_action_status", "204"]],
          conditions: [{ success_action_status: "204" }],
        }),
      )
      await post(
        s,
        "status 999",
        b,
        signedForm(s, b, {
          key: "five.txt",
          fields: [["success_action_status", "999"]],
          conditions: [["starts-with", "$success_action_status", ""]],
        }),
      )
      await s.req("list", { method: "GET", path: keyPath(b), query: { "list-type": "2" } })
      await post(
        s,
        "empty file",
        b,
        signedForm(s, b, { key: "empty.txt", file: { content: "", filename: "e.txt" } }),
      )
      await s.req("head empty", { method: "HEAD", path: keyPath(b, "empty.txt") })
      await post(
        s,
        "overwrite",
        b,
        signedForm(s, b, { file: { content: "second version", filename: "x" } }),
      )
      await s.req("get overwrite", { method: "GET", path: keyPath(b, "upload.txt") })
    },
  },
  {
    name: "redirect",
    async run(s) {
      const b = await s.bucket("post-redirect")
      await post(
        s,
        "redirect",
        b,
        signedForm(s, b, {
          fields: [["success_action_redirect", "http://example.com/done"]],
          conditions: [{ success_action_redirect: "http://example.com/done" }],
        }),
      )
      await post(
        s,
        "redirect with query",
        b,
        signedForm(s, b, {
          key: "a b.txt",
          fields: [["success_action_redirect", "https://example.com/cb?x=1&y=two"]],
          conditions: [["starts-with", "$success_action_redirect", "https://example.com/"]],
        }),
      )
      await post(
        s,
        "redirect and status",
        b,
        signedForm(s, b, {
          fields: [
            ["success_action_redirect", "http://example.com/"],
            ["success_action_status", "201"],
          ],
          conditions: [
            ["starts-with", "$success_action_redirect", ""],
            ["starts-with", "$success_action_status", ""],
          ],
        }),
      )
      await post(
        s,
        "redirect field not in policy",
        b,
        signedForm(s, b, { fields: [["success_action_redirect", "http://example.com/"]] }),
      )
    },
  },
  {
    name: "key-and-metadata",
    async run(s) {
      const b = await s.bucket("post-meta")
      await post(
        s,
        "filename substitution",
        b,
        signedForm(s, b, {
          key: `uploads/${FILENAME}`,
          file: { content: "png bytes", filename: "photo.png", type: "image/png" },
        }),
      )
      await s.req("get substituted", { method: "GET", path: keyPath(b, "uploads/photo.png") })
      await post(
        s,
        "filename without file name",
        b,
        signedForm(s, b, { key: `raw/${FILENAME}`, file: { content: "no name" } }),
      )
      await s.req("list raw", {
        method: "GET",
        path: keyPath(b),
        query: { "list-type": "2", prefix: "raw/" },
      })
      await post(s, "leading slash", b, signedForm(s, b, { key: "/lead.txt" }))
      await s.req("get lead", { method: "GET", path: keyPath(b, "lead.txt") })
      await post(
        s,
        "metadata and headers",
        b,
        signedForm(s, b, {
          key: "meta.txt",
          fields: [
            ["Content-Type", "text/markdown"],
            ["x-amz-meta-color", "blue"],
            ["X-Amz-Meta-Owner", "Ünïcode"],
            ["Cache-Control", "max-age=60"],
            ["Content-Disposition", "attachment; filename=meta.txt"],
          ],
          conditions: [
            ["starts-with", "$Content-Type", "text/"],
            { "x-amz-meta-color": "blue" },
            ["starts-with", "$x-amz-meta-owner", ""],
            ["starts-with", "$cache-control", ""],
            ["starts-with", "$content-disposition", ""],
          ],
        }),
      )
      await s.req("get meta", { method: "GET", path: keyPath(b, "meta.txt") })
      await post(
        s,
        "file part content type ignored",
        b,
        signedForm(s, b, {
          key: "typed.bin",
          file: { content: "x", filename: "a.json", type: "application/json" },
        }),
      )
      await s.req("head typed", { method: "HEAD", path: keyPath(b, "typed.bin") })
      await post(
        s,
        "ignored x-ignore field",
        b,
        signedForm(s, b, { key: "ignored.txt", fields: [["x-ignore-tracking", "1"]] }),
      )
      await post(
        s,
        "fields after the file are not read",
        b,
        signedForm(s, b, { key: "after.txt", after: [["x-amz-meta-late", "1"]] }),
      )
      await s.req("head after", { method: "HEAD", path: keyPath(b, "after.txt") })
      await post(
        s,
        "content-md5 field",
        b,
        signedForm(s, b, {
          key: "md5.txt",
          fields: [["Content-MD5", md5("posted content")]],
          conditions: [["starts-with", "$content-md5", ""]],
        }),
      )
      await post(
        s,
        "content-md5 mismatch",
        b,
        signedForm(s, b, {
          key: "md5bad.txt",
          fields: [["Content-MD5", md5("other")]],
          conditions: [["starts-with", "$content-md5", ""]],
        }),
      )
      await post(
        s,
        "content-md5 invalid",
        b,
        signedForm(s, b, {
          key: "md5bad.txt",
          fields: [["Content-MD5", "nope"]],
          conditions: [["starts-with", "$content-md5", ""]],
        }),
      )
      await s.req("head md5bad", { method: "HEAD", path: keyPath(b, "md5bad.txt") })
    },
  },
  {
    name: "policy-conditions",
    async run(s) {
      const b = await s.bucket("post-cond")
      await post(
        s,
        "eq key ok",
        b,
        signedForm(s, b, {
          key: "exact.txt",

          conditions: [["eq", "$key", "exact.txt"]],
        }),
      )
      await post(
        s,
        "eq key mismatch",
        b,
        signedForm(s, b, { key: "other.txt", conditions: [["eq", "$key", "exact.txt"]] }),
      )
      await post(
        s,
        "starts-with key ok",
        b,
        signedForm(s, b, { key: "user/1/a.txt", conditions: [["starts-with", "$key", "user/1/"]] }),
      )
      await post(
        s,
        "starts-with key mismatch",
        b,
        signedForm(s, b, { key: "user/2/a.txt", conditions: [["starts-with", "$key", "user/1/"]] }),
      )
      await post(
        s,
        "starts-with bucket refused",
        b,
        signedForm(s, b, { conditions: [["starts-with", "$bucket", ""]] }),
      )
      await post(
        s,
        "bucket mismatch",
        b,
        signedForm(s, b, {
          only: [
            { bucket: "some-other-bucket" },
            ["starts-with", "$key", ""],
            ["starts-with", "$x-amz-algorithm", ""],
          ],
        }),
      )
      await post(
        s,
        "eq meta mismatch",
        b,
        signedForm(s, b, {
          fields: [["x-amz-meta-a", "1"]],
          conditions: [{ "x-amz-meta-a": "2" }],
        }),
      )
      await post(
        s,
        "eq meta case-insensitive name",
        b,
        signedForm(s, b, {
          key: "ci.txt",
          fields: [["X-AMZ-META-A", "1"]],
          conditions: [["eq", "$X-Amz-Meta-A", "1"]],
        }),
      )
      await post(s, "unlisted field", b, signedForm(s, b, { fields: [["x-amz-meta-extra", "1"]] }))
      await post(
        s,
        "unlisted content-type",
        b,
        signedForm(s, b, { fields: [["Content-Type", "text/plain"]] }),
      )
      await post(
        s,
        "missing bucket condition",
        b,
        signedForm(s, b, {
          only: [
            ["starts-with", "$key", ""],
            { "x-amz-algorithm": "AWS4-HMAC-SHA256" },
            ["starts-with", "$x-amz-credential", ""],
            ["starts-with", "$x-amz-date", ""],
          ],
        }),
      )
      await post(
        s,
        "unknown condition key ignored",
        b,
        signedForm(s, b, { key: "unknown.txt", conditions: [["eq", "$foo", "bar"]] }),
      )
      await post(
        s,
        "duplicate form field",
        b,
        signedForm(s, b, {
          fields: [
            ["x-amz-meta-a", "1"],
            ["x-amz-meta-a", "2"],
          ],
          conditions: [["starts-with", "$x-amz-meta-a", ""]],
        }),
      )
      await post(
        s,
        "length in range",
        b,
        signedForm(s, b, { key: "range.txt", conditions: [["content-length-range", 1, 100]] }),
      )
      await post(
        s,
        "length too large",
        b,
        signedForm(s, b, { key: "big.txt", conditions: [["content-length-range", 0, 5]] }),
      )
      await post(
        s,
        "length too small",
        b,
        signedForm(s, b, { key: "small.txt", conditions: [["content-length-range", 1000, 2000]] }),
      )
      await post(
        s,
        "length as strings",
        b,
        signedForm(s, b, { key: "str.txt", conditions: [["content-length-range", "1", "100"]] }),
      )
      await post(
        s,
        "length bad number",
        b,
        signedForm(s, b, { conditions: [["content-length-range", "one", 100]] }),
      )
      await s.req("list", { method: "GET", path: keyPath(b), query: { "list-type": "2" } })
    },
  },
  {
    name: "policy-document",
    async run(s) {
      const b = await s.bucket("post-doc")
      const encode = (value: unknown) =>
        Buffer.from(typeof value === "string" ? value : JSON.stringify(value)).toString("base64")
      await post(s, "expired", b, signedForm(s, b, { expiration: "2000-01-01T00:00:00.000Z" }))
      await post(
        s,
        "expiration without millis",
        b,
        signedForm(s, b, { key: "nomillis.txt", expiration: "2100-01-01T00:00:00Z" }),
      )
      await post(s, "malformed expiration", b, signedForm(s, b, { expiration: "tomorrow" }))
      await post(s, "not base64", b, signedForm(s, b, { policy: "%%% not base64 %%%" }))
      await post(
        s,
        "unknown top-level field",
        b,
        signedForm(s, b, { policy: encode({ expiration: FUTURE, conditions: [], extra: 1 }) }),
      )
      await post(
        s,
        "two-element condition",
        b,
        signedForm(s, b, { policy: encode({ expiration: FUTURE, conditions: [["eq", "$key"]] }) }),
      )
      await post(
        s,
        "unknown operator",
        b,
        signedForm(s, b, {
          policy: encode({ expiration: FUTURE, conditions: [["lt", "$key", "a"]] }),
        }),
      )
      await post(
        s,
        "match type without dollar",
        b,
        signedForm(s, b, {
          policy: encode({ expiration: FUTURE, conditions: [["eq", "key", "a"]] }),
        }),
      )
      await post(
        s,
        "non-string map value",
        b,
        signedForm(s, b, { policy: encode({ expiration: FUTURE, conditions: [{ bucket: 1 }] }) }),
      )
      await post(
        s,
        "condition of wrong type",
        b,
        signedForm(s, b, { policy: encode({ expiration: FUTURE, conditions: ["bucket"] }) }),
      )
      await post(
        s,
        "duplicate json key",
        b,
        signedForm(s, b, {
          policy: encode(`{"expiration":"${FUTURE}","expiration":"${FUTURE}","conditions":[]}`),
        }),
      )
      await post(
        s,
        "no policy field at all",
        b,
        signedForm(s, b, { key: "nopolicy.txt", policy: "" }),
      )
      await s.req("head nopolicy", { method: "HEAD", path: keyPath(b, "nopolicy.txt") })
    },
  },
  {
    name: "signatures",
    async run(s) {
      const b = await s.bucket("post-sig")
      await post(
        s,
        "bad signature",
        b,
        signedForm(s, b, { override: { "x-amz-signature": "0".repeat(64) } }),
      )
      await post(
        s,
        "wrong secret",
        b,
        signedForm(s, b, {
          credentials: { accessKey: s.target.accessKey, secretKey: "wrong-secret" },
        }),
      )
      await post(
        s,
        "unknown key",
        b,
        signedForm(s, b, { credentials: { accessKey: "nobody-here", secretKey: "x" } }),
      )
      await post(s, "wrong region", b, signedForm(s, b, { region: "eu-west-1" }))
      await post(s, "no credential", b, signedForm(s, b, { omit: ["x-amz-credential"] }))
      await post(
        s,
        "malformed credential",
        b,
        signedForm(s, b, { override: { "x-amz-credential": "mockingbird/2024" } }),
      )
      await post(s, "no signature", b, signedForm(s, b, { omit: ["x-amz-signature"] }))
      await post(
        s,
        "no algorithm",
        b,
        signedForm(s, b, { key: "noalg.txt", omit: ["x-amz-algorithm"] }),
      )
      await post(s, "no date", b, signedForm(s, b, { omit: ["x-amz-date"] }))
      await post(
        s,
        "no auth fields",
        b,
        signedForm(s, b, {
          omit: ["x-amz-algorithm", "x-amz-credential", "x-amz-date", "x-amz-signature"],
        }),
      )
      await post(s, "v2 signature", b, signedForm(s, b, { key: "v2.txt", v2: true }))
      await s.req("get v2", { method: "GET", path: keyPath(b, "v2.txt") })
      await post(
        s,
        "v2 bad signature",
        b,
        signedForm(s, b, { v2: true, override: { signature: "AAAA" } }),
      )
      await post(
        s,
        "v2 unknown key",
        b,
        signedForm(s, b, { v2: true, credentials: { accessKey: "nobody-here", secretKey: "x" } }),
      )
    },
  },
  {
    name: "form-errors",
    async run(s) {
      const b = await s.bucket("post-form")
      await post(s, "missing file", b, signedForm(s, b, { file: null }))
      await post(s, "missing key", b, signedForm(s, b, { key: "" }))
      await post(
        s,
        "key after file",
        b,
        signedForm(s, b, { key: "", after: [["key", "late.txt"]] }),
      )
      await post(
        s,
        "file under other name",
        b,
        signedForm(s, b, { file: { content: "x", filename: "a", field: "upload" } }),
      )
      await post(s, "empty body", b, "")
      await post(s, "garbage body", b, "this is not multipart at all")
      await post(
        s,
        "missing closing boundary",
        b,
        signedForm(s, b).replace(`--${BOUNDARY}--\r\n`, ""),
      )
      await s.req("no boundary parameter", {
        method: "POST",
        path: keyPath(b),
        auth: "anonymous",
        headers: { "content-type": "multipart/form-data" },
        body: signedForm(s, b),
      })
      await post(
        s,
        "missing bucket",
        "post-missing-bucket-zz",
        signedForm(s, "post-missing-bucket-zz"),
      )
      await post(s, "to an object path", b, signedForm(s, b), keyPath(b, "some-key"))
      await post(
        s,
        "with tagging",
        b,
        signedForm(s, b, {
          key: "tagged.txt",
          fields: [
            [
              "tagging",
              "<Tagging><TagSet><Tag><Key>a</Key><Value>1</Value></Tag></TagSet></Tagging>",
            ],
          ],
          conditions: [["starts-with", "$tagging", ""]],
        }),
      )
      await post(
        s,
        "with bad tagging",
        b,
        signedForm(s, b, {
          key: "badtag.txt",
          fields: [["tagging", "<Tagging>"]],
          conditions: [["starts-with", "$tagging", ""]],
        }),
      )
      await s.req("head tagged", { method: "HEAD", path: keyPath(b, "tagged.txt") })
      await s.req("list", { method: "GET", path: keyPath(b), query: { "list-type": "2" } })
    },
  },
]
