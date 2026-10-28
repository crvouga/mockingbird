/**
 * CopyObject (`PUT /<bucket>/<key>` with `x-amz-copy-source`), per MinIO's `CopyObjectHandler`:
 * copy-source parsing, directives, the self-copy rule, `x-amz-copy-source-if-*` preconditions,
 * versioned sources and destinations, checksums, and the CopyObjectResult body.
 */
import { crc32 } from "node:zlib"
import { CopyObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3"
import { type Ctx, keyPath, type Scenario, uriEncode } from "../harness.js"

const PAST = "Mon, 01 Jan 1990 00:00:00 GMT"
const FUTURE = "Fri, 01 Jan 2100 00:00:00 GMT"
const NO_ETAG = '"00000000000000000000000000000000"'
const MISSING_UUID = "0b1c2d3e-4f50-4a6b-8c7d-8e9fa0b1c2d3"

/** PUT an object (unrecorded) and return its quoted ETag and version id. */
const put = async (
  s: Ctx,
  bucket: string,
  key: string,
  body = "hello copy",
  headers: Record<string, string> = {},
) => {
  const res = await s.raw({
    method: "PUT",
    path: keyPath(bucket, key),
    body,
    headers: { "content-type": "text/plain", ...headers },
  })
  if (res.status !== 200) throw new Error(`setup put ${key}: ${res.status} ${res.text}`)
  return {
    etag: res.headers.get("etag") ?? "",
    versionId: res.headers.get("x-amz-version-id") ?? "",
  }
}

/** A multipart upload of `parts` (unrecorded); returns the quoted ETag. */
const multipartPut = async (
  s: Ctx,
  bucket: string,
  key: string,
  parts: string[],
  algorithm?: "CRC32",
) => {
  const path = keyPath(bucket, key)
  const init = await s.raw({
    method: "POST",
    path,
    query: { uploads: "" },
    ...(algorithm ? { headers: { "x-amz-checksum-algorithm": algorithm } } : {}),
  })
  const uploadId = init.tag("UploadId") ?? ""
  let body = '<CompleteMultipartUpload xmlns="http://s3.amazonaws.com/doc/2006-03-01/">'
  for (const [index, part] of parts.entries()) {
    const crc = algorithm ? crc32Base64(part) : undefined
    const res = await s.raw({
      method: "PUT",
      path,
      query: { partNumber: String(index + 1), uploadId },
      body: part,
      ...(crc ? { headers: { "x-amz-checksum-crc32": crc } } : {}),
    })
    body +=
      `<Part><PartNumber>${index + 1}</PartNumber><ETag>${res.headers.get("etag")}</ETag>` +
      `${crc ? `<ChecksumCRC32>${crc}</ChecksumCRC32>` : ""}</Part>`
  }
  const done = await s.raw({
    method: "POST",
    path,
    query: { uploadId },
    body: `${body}</CompleteMultipartUpload>`,
  })
  if (done.status !== 200) throw new Error(`setup complete ${key}: ${done.status} ${done.text}`)
  return `"${(done.tag("ETag") ?? "").replace(/"|&#34;/g, "")}"`
}

const crc32Base64 = (text: string) => {
  const value = crc32(Buffer.from(text))
  return Buffer.from([
    value >>> 24,
    (value >>> 16) & 255,
    (value >>> 8) & 255,
    value & 255,
  ]).toString("base64")
}

/** A recorded CopyObject. */
const copy = (
  s: Ctx,
  step: string,
  bucket: string,
  key: string,
  source: string,
  headers: Record<string, string> = {},
) =>
  s.req(step, {
    method: "PUT",
    path: keyPath(bucket, key),
    headers: { "x-amz-copy-source": source, ...headers },
  })

const head = (s: Ctx, step: string, bucket: string, key: string, query?: Record<string, string>) =>
  s.req(step, { method: "HEAD", path: keyPath(bucket, key), ...(query ? { query } : {}) })
const get = (s: Ctx, step: string, bucket: string, key: string, query?: Record<string, string>) =>
  s.req(step, { method: "GET", path: keyPath(bucket, key), ...(query ? { query } : {}) })

/** One scenario per precondition case: setup, copy with `headers`, then check the destination. */
const precondition = (
  name: string,
  headers: (etag: string) => Record<string, string>,
): Scenario => ({
  name: `precondition-${name}`,
  async run(s) {
    const b = await s.bucket("copy-pre")
    const { etag } = await put(s, b, "src")
    await copy(s, "copy", b, "dst", `${b}/src`, headers(etag))
    await head(s, "head-dst", b, "dst")
  },
})

export const scenarios: Scenario[] = [
  {
    name: "basic",
    async run(s) {
      const b = await s.bucket("copy-basic")
      await put(s, b, "src", "hello copy", {
        "x-amz-meta-color": "blue",
        "cache-control": "max-age=60",
        "content-disposition": "attachment",
      })
      await copy(s, "copy", b, "dst", `${b}/src`)
      await head(s, "head-dst", b, "dst")
      await get(s, "get-dst", b, "dst")
      await head(s, "head-src", b, "src")
    },
  },
  {
    name: "source-leading-slash",
    async run(s) {
      const b = await s.bucket("copy-slash")
      await put(s, b, "dir/src")
      await copy(s, "copy", b, "dst", `/${b}/dir/src`)
      await head(s, "head-dst", b, "dst")
    },
  },
  {
    name: "source-encoded-keys",
    async run(s) {
      const b = await s.bucket("copy-enc")
      const keys = ["a b.txt", "plus+sign", "ünïcødé/日本語", "q?mark&amp", "pct%41", "tilde~*()'!"]
      for (const key of keys) await put(s, b, key, `body of ${key}`)
      let index = 0
      for (const key of keys) {
        index++
        await copy(s, `copy-${index}`, b, `out/${index}`, `${b}/${uriEncode(key, true)}`)
        await get(s, `get-${index}`, b, `out/${index}`)
      }
    },
  },
  {
    name: "source-raw-plus",
    async run(s) {
      const b = await s.bucket("copy-plus")
      await put(s, b, "a+b", "plus")
      await put(s, b, "a b", "space")
      // An unencoded `+` in the path stays a `+`.
      await copy(s, "copy-plus", b, "dst-plus", `${b}/a+b`)
      await get(s, "get-plus", b, "dst-plus")
      await copy(s, "copy-space", b, "dst-space", `${b}/a%20b`)
      await get(s, "get-space", b, "dst-space")
    },
  },
  {
    name: "source-encoded-slash",
    async run(s) {
      const b = await s.bucket("copy-encslash")
      await put(s, b, "dir/src")
      await copy(s, "copy", b, "dst", `${b}%2Fdir%2Fsrc`)
      await head(s, "head-dst", b, "dst")
    },
  },
  {
    name: "source-invalid-escape",
    async run(s) {
      const b = await s.bucket("copy-badesc")
      await put(s, b, "k%zz")
      await copy(s, "copy", b, "dst", `${b}/k%zz`)
      await copy(s, "copy-missing", b, "dst2", `${b}/x%zz`)
    },
  },
  {
    name: "source-malformed",
    async run(s) {
      const b = await s.bucket("copy-malformed")
      await put(s, b, "src")
      await copy(s, "bucket-slash", b, "dst", `${b}/`)
      await copy(s, "slash-bucket", b, "dst", `/${b}`)
      await copy(s, "slash-only", b, "dst", "/")
      await copy(s, "double-slash", b, "dst", "//src")
      await copy(s, "slash-bucket-slash", b, "dst", `/${b}/`)
      await head(s, "head-dst", b, "dst")
    },
  },
  {
    name: "source-without-slash-is-put",
    async run(s) {
      const b = await s.bucket("copy-noslash")
      await put(s, b, "src")
      // No `/` in the header: the router does not treat it as a copy.
      await s.req("put", {
        method: "PUT",
        path: keyPath(b, "dst"),
        body: "plain body",
        headers: { "x-amz-copy-source": b },
      })
      await get(s, "get-dst", b, "dst")
    },
  },
  {
    name: "source-missing-key",
    async run(s) {
      const b = await s.bucket("copy-nokey")
      await copy(s, "copy", b, "dst", `${b}/nope`)
      await copy(s, "copy-nested", b, "dst", `${b}/a/b/c`)
      await head(s, "head-dst", b, "dst")
    },
  },
  {
    name: "source-missing-bucket",
    async run(s) {
      const b = await s.bucket("copy-nosrcb")
      await copy(s, "copy", b, "dst", `${s.name("copy-absent")}/k`)
      await copy(s, "copy-invalid-name", b, "dst", "x/k")
    },
  },
  {
    name: "destination-missing-bucket",
    async run(s) {
      const b = await s.bucket("copy-nodstb")
      await put(s, b, "src")
      await copy(s, "copy", s.name("copy-absent-dst"), "dst", `${b}/src`)
      await copy(s, "copy-both-missing", s.name("copy-absent-dst"), "dst", `${b}/nope`)
    },
  },
  {
    name: "cross-bucket",
    async run(s) {
      const a = await s.bucket("copy-xa")
      const b = await s.bucket("copy-xb")
      await put(s, a, "src", "across", { "x-amz-meta-k": "v" })
      await copy(s, "copy", b, "dst", `${a}/src`)
      await head(s, "head-dst", b, "dst")
      await get(s, "get-dst", b, "dst")
    },
  },
  {
    name: "same-key-cross-bucket",
    async run(s) {
      const a = await s.bucket("copy-sa")
      const b = await s.bucket("copy-sb")
      await put(s, a, "same", "same key")
      await copy(s, "copy", b, "same", `${a}/same`)
      await get(s, "get-dst", b, "same")
    },
  },
  {
    name: "overwrite-destination",
    async run(s) {
      const b = await s.bucket("copy-over")
      await put(s, b, "src", "new content", { "x-amz-meta-from": "src" })
      await put(s, b, "dst", "old content that is longer", { "x-amz-meta-from": "dst" })
      await copy(s, "copy", b, "dst", `${b}/src`)
      await get(s, "get-dst", b, "dst")
    },
  },
  {
    name: "empty-object",
    async run(s) {
      const b = await s.bucket("copy-empty")
      await put(s, b, "empty", "")
      await copy(s, "copy", b, "dst", `${b}/empty`)
      await head(s, "head-dst", b, "dst")
      await get(s, "get-dst", b, "dst")
    },
  },
  {
    name: "metadata-directive-copy",
    async run(s) {
      const b = await s.bucket("copy-mdcopy")
      await put(s, b, "src", "x", { "x-amz-meta-a": "1", "content-language": "en" })
      await copy(s, "copy", b, "dst", `${b}/src`, {
        "x-amz-metadata-directive": "COPY",
        "x-amz-meta-b": "2",
        "content-type": "image/png",
        "cache-control": "no-cache",
      })
      await head(s, "head-dst", b, "dst")
    },
  },
  {
    name: "metadata-directive-replace",
    async run(s) {
      const b = await s.bucket("copy-mdrepl")
      await put(s, b, "src", "x", {
        "x-amz-meta-a": "1",
        "cache-control": "max-age=1",
        "content-disposition": "inline",
      })
      await copy(s, "copy", b, "dst", `${b}/src`, {
        "x-amz-metadata-directive": "REPLACE",
        "x-amz-meta-b": "2",
        "x-amz-meta-Mixed-Case": "MiXeD",
        "content-type": "image/png",
        "cache-control": "no-cache",
        "content-disposition": 'attachment; filename="a.png"',
        "content-encoding": "gzip",
        "content-language": "fr",
        expires: "Thu, 01 Dec 2094 16:00:00 GMT",
      })
      await head(s, "head-dst", b, "dst")
    },
  },
  {
    name: "metadata-directive-replace-defaults",
    async run(s) {
      const b = await s.bucket("copy-mdrdef")
      await put(s, b, "src", "x", { "x-amz-meta-a": "1", "content-type": "text/html" })
      // REPLACE with nothing: user metadata dropped, content type defaults.
      await copy(s, "copy", b, "dst", `${b}/src`, { "x-amz-metadata-directive": "REPLACE" })
      await head(s, "head-dst", b, "dst")
    },
  },
  {
    name: "metadata-directive-invalid",
    async run(s) {
      const b = await s.bucket("copy-mdbad")
      await put(s, b, "src")
      await copy(s, "lowercase", b, "dst", `${b}/src`, { "x-amz-metadata-directive": "replace" })
      await copy(s, "garbage", b, "dst", `${b}/src`, { "x-amz-metadata-directive": "MOVE" })
      await copy(s, "missing-source", b, "dst", `${b}/nope`, { "x-amz-metadata-directive": "X" })
      await copy(s, "malformed-source", b, "dst", `${b}/`, { "x-amz-metadata-directive": "X" })
      await head(s, "head-dst", b, "dst")
    },
  },
  {
    name: "tagging-directive-copy",
    async run(s) {
      const b = await s.bucket("copy-tagcopy")
      await put(s, b, "src", "x", { "x-amz-tagging": "a=1&b=2" })
      await copy(s, "copy-default", b, "dst1", `${b}/src`)
      await get(s, "tags-dst1", b, "dst1", { tagging: "" })
      await head(s, "head-dst1", b, "dst1")
      await copy(s, "copy-explicit", b, "dst2", `${b}/src`, {
        "x-amz-tagging-directive": "COPY",
        "x-amz-tagging": "c=3",
      })
      await get(s, "tags-dst2", b, "dst2", { tagging: "" })
    },
  },
  {
    name: "tagging-directive-replace",
    async run(s) {
      const b = await s.bucket("copy-tagrepl")
      await put(s, b, "src", "x", { "x-amz-tagging": "a=1" })
      await copy(s, "copy", b, "dst", `${b}/src`, {
        "x-amz-tagging-directive": "REPLACE",
        "x-amz-tagging": "x=9&y=8",
      })
      await get(s, "tags-dst", b, "dst", { tagging: "" })
      await copy(s, "copy-empty", b, "dst2", `${b}/src`, { "x-amz-tagging-directive": "REPLACE" })
      await get(s, "tags-dst2", b, "dst2", { tagging: "" })
      await head(s, "head-dst2", b, "dst2")
    },
  },
  {
    name: "tagging-directive-invalid",
    async run(s) {
      const b = await s.bucket("copy-tagbad")
      await put(s, b, "src")
      await copy(s, "lowercase", b, "dst", `${b}/src`, { "x-amz-tagging-directive": "copy" })
      await copy(s, "both-invalid", b, "dst", `${b}/src`, {
        "x-amz-tagging-directive": "X",
        "x-amz-metadata-directive": "Y",
      })
      await copy(s, "bad-tags", b, "dst", `${b}/src`, {
        "x-amz-tagging-directive": "REPLACE",
        "x-amz-tagging": "a=1&a=2",
      })
      await copy(s, "bad-tags-key", b, "dst", `${b}/src`, {
        "x-amz-tagging-directive": "REPLACE",
        "x-amz-tagging": `${"k".repeat(129)}=v`,
      })
      await head(s, "head-dst", b, "dst")
    },
  },
  {
    name: "tagging-with-metadata-replace",
    async run(s) {
      const b = await s.bucket("copy-tagmd")
      await put(s, b, "tagged", "x", { "x-amz-tagging": "src=1" })
      await put(s, b, "untagged", "y")
      // Metadata REPLACE keeps the source's tags (tag directive COPY)...
      await copy(s, "copy-tagged", b, "dst1", `${b}/tagged`, {
        "x-amz-metadata-directive": "REPLACE",
        "x-amz-tagging": "hdr=2",
      })
      await get(s, "tags-dst1", b, "dst1", { tagging: "" })
      // ...and an untagged source takes the request's x-amz-tagging with it.
      await copy(s, "copy-untagged", b, "dst2", `${b}/untagged`, {
        "x-amz-metadata-directive": "REPLACE",
        "x-amz-tagging": "hdr=2",
      })
      await get(s, "tags-dst2", b, "dst2", { tagging: "" })
    },
  },
  {
    name: "self-copy-without-changes",
    async run(s) {
      const b = await s.bucket("copy-self")
      await put(s, b, "k", "same", { "x-amz-meta-a": "1" })
      await copy(s, "copy", b, "k", `${b}/k`)
      await copy(s, "copy-directive-copy", b, "k", `${b}/k`, { "x-amz-metadata-directive": "COPY" })
      await copy(s, "copy-tag-copy", b, "k", `${b}/k`, { "x-amz-tagging-directive": "COPY" })
      await copy(s, "copy-leading-slash", b, "k", `/${b}/k`)
      await copy(s, "copy-same-storage-class", b, "k", `${b}/k`, {
        "x-amz-storage-class": "STANDARD",
      })
      await copy(s, "copy-checksum-algorithm", b, "k", `${b}/k`, {
        "x-amz-checksum-algorithm": "SHA256",
      })
      await head(s, "head", b, "k")
    },
  },
  {
    name: "self-copy-replace-metadata",
    async run(s) {
      const b = await s.bucket("copy-selfrepl")
      await put(s, b, "k", "same", { "x-amz-meta-a": "1" })
      await copy(s, "copy", b, "k", `${b}/k`, {
        "x-amz-metadata-directive": "REPLACE",
        "x-amz-meta-b": "2",
        "content-type": "application/json",
      })
      await head(s, "head", b, "k")
      await get(s, "get", b, "k")
    },
  },
  {
    name: "self-copy-replace-tagging",
    async run(s) {
      const b = await s.bucket("copy-selftag")
      await put(s, b, "k", "same", { "x-amz-meta-a": "1", "x-amz-tagging": "a=1" })
      await copy(s, "copy", b, "k", `${b}/k`, {
        "x-amz-tagging-directive": "REPLACE",
        "x-amz-tagging": "b=2",
      })
      await get(s, "tags", b, "k", { tagging: "" })
      await head(s, "head", b, "k")
    },
  },
  {
    name: "self-copy-storage-class",
    async run(s) {
      const b = await s.bucket("copy-selfsc")
      await put(s, b, "k", "same", { "x-amz-meta-a": "1" })
      await copy(s, "copy", b, "k", `${b}/k`, { "x-amz-storage-class": "REDUCED_REDUNDANCY" })
      await head(s, "head", b, "k")
    },
  },
  {
    name: "storage-class",
    async run(s) {
      const b = await s.bucket("copy-sc")
      await put(s, b, "src", "x", { "x-amz-storage-class": "REDUCED_REDUNDANCY" })
      await copy(s, "copy-keeps", b, "dst1", `${b}/src`)
      await head(s, "head-dst1", b, "dst1")
      await copy(s, "copy-standard", b, "dst2", `${b}/src`, { "x-amz-storage-class": "STANDARD" })
      await head(s, "head-dst2", b, "dst2")
      await copy(s, "copy-replace-no-class", b, "dst3", `${b}/src`, {
        "x-amz-metadata-directive": "REPLACE",
      })
      await head(s, "head-dst3", b, "dst3")
      await copy(s, "copy-invalid", b, "dst4", `${b}/src`, { "x-amz-storage-class": "GLACIER" })
      await copy(s, "copy-invalid-missing-src", b, "dst4", `${b}/nope`, {
        "x-amz-storage-class": "BOGUS",
      })
    },
  },
  precondition("if-match-ok", (etag) => ({ "x-amz-copy-source-if-match": etag })),
  precondition("if-match-unquoted", (etag) => ({
    "x-amz-copy-source-if-match": etag.replace(/"/g, ""),
  })),
  precondition("if-match-star", () => ({ "x-amz-copy-source-if-match": "*" })),
  precondition("if-match-fail", () => ({ "x-amz-copy-source-if-match": NO_ETAG })),
  precondition("if-match-list", (etag) => ({
    "x-amz-copy-source-if-match": `${NO_ETAG}, ${etag}`,
  })),
  precondition("if-none-match-ok", () => ({ "x-amz-copy-source-if-none-match": NO_ETAG })),
  precondition("if-none-match-fail", (etag) => ({ "x-amz-copy-source-if-none-match": etag })),
  precondition("if-none-match-star", () => ({ "x-amz-copy-source-if-none-match": "*" })),
  precondition("if-modified-since-ok", () => ({ "x-amz-copy-source-if-modified-since": PAST })),
  precondition("if-modified-since-fail", () => ({
    "x-amz-copy-source-if-modified-since": FUTURE,
  })),
  precondition("if-modified-since-invalid", () => ({
    "x-amz-copy-source-if-modified-since": "not a date",
  })),
  precondition("if-modified-since-single-digit-day", () => ({
    "x-amz-copy-source-if-modified-since": "Fri, 1 Jan 2100 00:00:00 GMT",
  })),
  precondition("if-modified-since-iso", () => ({
    "x-amz-copy-source-if-modified-since": "2100-01-01T00:00:00Z",
  })),
  precondition("if-unmodified-since-ok", () => ({
    "x-amz-copy-source-if-unmodified-since": FUTURE,
  })),
  precondition("if-unmodified-since-fail", () => ({
    "x-amz-copy-source-if-unmodified-since": PAST,
  })),
  precondition("if-unmodified-since-invalid", () => ({
    "x-amz-copy-source-if-unmodified-since": "yesterday",
  })),
  precondition("if-match-ok-unmodified-since-fail", (etag) => ({
    "x-amz-copy-source-if-match": etag,
    "x-amz-copy-source-if-unmodified-since": PAST,
  })),
  precondition("if-match-fail-unmodified-since-ok", () => ({
    "x-amz-copy-source-if-match": NO_ETAG,
    "x-amz-copy-source-if-unmodified-since": FUTURE,
  })),
  precondition("if-none-match-fail-modified-since-ok", (etag) => ({
    "x-amz-copy-source-if-none-match": etag,
    "x-amz-copy-source-if-modified-since": PAST,
  })),
  precondition("if-none-match-ok-modified-since-fail", () => ({
    "x-amz-copy-source-if-none-match": NO_ETAG,
    "x-amz-copy-source-if-modified-since": FUTURE,
  })),
  precondition("if-match-and-none-match-ok", (etag) => ({
    "x-amz-copy-source-if-match": etag,
    "x-amz-copy-source-if-none-match": NO_ETAG,
  })),
  precondition("if-match-ok-none-match-fail", (etag) => ({
    "x-amz-copy-source-if-match": etag,
    "x-amz-copy-source-if-none-match": etag,
  })),
  precondition("all-four-ok", (etag) => ({
    "x-amz-copy-source-if-match": etag,
    "x-amz-copy-source-if-none-match": NO_ETAG,
    "x-amz-copy-source-if-modified-since": PAST,
    "x-amz-copy-source-if-unmodified-since": FUTURE,
  })),
  precondition("modified-and-unmodified-fail", () => ({
    "x-amz-copy-source-if-modified-since": FUTURE,
    "x-amz-copy-source-if-unmodified-since": PAST,
  })),
  precondition("plain-if-match-ignored", () => ({ "if-match": NO_ETAG })),
  {
    name: "precondition-missing-source",
    async run(s) {
      const b = await s.bucket("copy-premiss")
      await copy(s, "copy", b, "dst", `${b}/nope`, { "x-amz-copy-source-if-match": NO_ETAG })
    },
  },
  {
    name: "precondition-self-copy",
    async run(s) {
      const b = await s.bucket("copy-preself")
      await put(s, b, "k")
      // The precondition is evaluated before the self-copy rule.
      await copy(s, "fail", b, "k", `${b}/k`, { "x-amz-copy-source-if-match": NO_ETAG })
      await copy(s, "pass", b, "k", `${b}/k`, { "x-amz-copy-source-if-none-match": NO_ETAG })
    },
  },
  {
    name: "versioned-destination",
    async run(s) {
      const b = await s.bucket("copy-vdst", { versioning: "Enabled" })
      await put(s, b, "src", "v1")
      await copy(s, "copy", b, "dst", `${b}/src`)
      await copy(s, "copy-again", b, "dst", `${b}/src`)
      await s.req("versions", { method: "GET", path: keyPath(b), query: { versions: "" } })
    },
  },
  {
    name: "versioned-source-version-id",
    async run(s) {
      const b = await s.bucket("copy-vsrc", { versioning: "Enabled" })
      const first = await put(s, b, "src", "first")
      await put(s, b, "src", "second")
      const dst = await s.bucket("copy-vplain")
      await copy(s, "copy-old", dst, "dst", `${b}/src?versionId=${first.versionId}`)
      await get(s, "get-dst", dst, "dst")
      await copy(s, "copy-latest", dst, "dst2", `${b}/src`)
      await get(s, "get-dst2", dst, "dst2")
      await copy(s, "copy-missing-version", dst, "dst3", `${b}/src?versionId=${MISSING_UUID}`)
      await copy(s, "copy-invalid-version", dst, "dst3", `${b}/src?versionId=not-a-uuid`)
      await copy(s, "copy-empty-version", dst, "dst4", `${b}/src?versionId=`)
      await copy(s, "copy-null-version", dst, "dst5", `${b}/src?versionId=null`)
      await copy(s, "copy-space-version", dst, "dst6", `${b}/src?versionId=%20`)
    },
  },
  {
    name: "versioned-self-copy-old-version",
    async run(s) {
      const b = await s.bucket("copy-vself", { versioning: "Enabled" })
      const first = await put(s, b, "k", "first")
      await put(s, b, "k", "second")
      // Naming a version makes a self-copy legal: it restores the old version as the latest.
      await copy(s, "restore", b, "k", `${b}/k?versionId=${first.versionId}`)
      await get(s, "get", b, "k")
      await copy(s, "self-latest", b, "k", `${b}/k`)
    },
  },
  {
    name: "unversioned-source-version-ids",
    async run(s) {
      const b = await s.bucket("copy-unvsrc")
      await put(s, b, "src", "plain")
      await copy(s, "copy-null", b, "dst", `${b}/src?versionId=null`)
      await get(s, "get-dst", b, "dst")
      await copy(s, "copy-uuid", b, "dst2", `${b}/src?versionId=${MISSING_UUID}`)
      await copy(s, "copy-self-null", b, "src", `${b}/src?versionId=null`)
    },
  },
  {
    name: "source-delete-marker",
    async run(s) {
      const b = await s.bucket("copy-dm", { versioning: "Enabled" })
      await put(s, b, "src", "gone")
      const del = await s.raw({ method: "DELETE", path: keyPath(b, "src") })
      const marker = del.headers.get("x-amz-version-id") ?? ""
      await copy(s, "copy-latest", b, "dst", `${b}/src`)
      await copy(s, "copy-marker", b, "dst", `${b}/src?versionId=${marker}`)
    },
  },
  {
    name: "suspended-source-and-destination",
    async run(s) {
      const b = await s.bucket("copy-susp", { versioning: "Suspended" })
      await put(s, b, "src", "susp")
      await copy(s, "copy", b, "dst", `${b}/src`)
      await copy(s, "copy-null", b, "dst2", `${b}/src?versionId=null`)
      await head(s, "head-dst", b, "dst")
    },
  },
  {
    name: "checksum-algorithm",
    async run(s) {
      const b = await s.bucket("copy-cks")
      await put(s, b, "src", "checksum me")
      for (const algorithm of ["CRC32", "CRC32C", "CRC64NVME", "SHA1", "SHA256"])
        await copy(s, `copy-${algorithm}`, b, `dst-${algorithm}`, `${b}/src`, {
          "x-amz-checksum-algorithm": algorithm,
        })
      await copy(s, "copy-lowercase", b, "dst-lower", `${b}/src`, {
        "x-amz-checksum-algorithm": "sha256",
      })
      await copy(s, "copy-invalid", b, "dst-bad", `${b}/src`, {
        "x-amz-checksum-algorithm": "MD5",
      })
      await s.req("head-sha256", {
        method: "HEAD",
        path: keyPath(b, "dst-SHA256"),
        headers: { "x-amz-checksum-mode": "ENABLED" },
      })
    },
  },
  {
    name: "checksum-from-source",
    async run(s) {
      const b = await s.bucket("copy-ckssrc")
      await put(s, b, "src", "checksum me", {
        "x-amz-checksum-sha1": "ADN8+yBInHK3NrJo/boywCe91is=",
      })
      await copy(s, "copy", b, "dst", `${b}/src`)
      await copy(s, "copy-other-algorithm", b, "dst2", `${b}/src`, {
        "x-amz-checksum-algorithm": "CRC32",
      })
    },
  },
  {
    name: "multipart-source",
    async run(s) {
      const b = await s.bucket("copy-mpu")
      const etag = await multipartPut(s, b, "big", ["part one body"])
      await head(s, "head-src", b, "big")
      // The copy is a single-part object: its ETag is the MD5 of the bytes, not `<md5>-1`.
      await copy(s, "copy", b, "dst", `${b}/big`, { "x-amz-copy-source-if-match": etag })
      await head(s, "head-dst", b, "dst")
      await head(s, "head-dst-part", b, "dst", { partNumber: "1" })
      await copy(s, "self-replace", b, "big", `${b}/big`, { "x-amz-metadata-directive": "REPLACE" })
      await head(s, "head-self", b, "big")
    },
  },
  {
    name: "multipart-checksum-source",
    async run(s) {
      const b = await s.bucket("copy-mpucks")
      await multipartPut(s, b, "big", ["part one body"], "CRC32")
      await s.req("head-src", {
        method: "HEAD",
        path: keyPath(b, "big"),
        headers: { "x-amz-checksum-mode": "ENABLED" },
      })
      // A composite source checksum becomes a full-object checksum of the same algorithm.
      await copy(s, "copy", b, "dst", `${b}/big`)
      await s.req("head-dst", {
        method: "HEAD",
        path: keyPath(b, "dst"),
        headers: { "x-amz-checksum-mode": "ENABLED" },
      })
    },
  },
  {
    name: "precondition-on-old-version",
    async run(s) {
      const b = await s.bucket("copy-prever", { versioning: "Enabled" })
      const first = await put(s, b, "src", "first")
      await put(s, b, "src", "second")
      await copy(s, "match-old", b, "dst", `${b}/src?versionId=${first.versionId}`, {
        "x-amz-copy-source-if-match": first.etag,
      })
      await copy(s, "match-latest-fails", b, "dst", `${b}/src`, {
        "x-amz-copy-source-if-match": first.etag,
      })
    },
  },
  {
    name: "sdk-copy",
    async run(s) {
      const b = await s.bucket("copy-sdk")
      await put(s, b, "src key", "via sdk", { "x-amz-meta-who": "sdk" })
      const client = s.sdk()
      const result = await client.send(
        new CopyObjectCommand({ Bucket: b, Key: "dst", CopySource: `${b}/src%20key` }),
      )
      s.record("copy", result)
      s.record("head", await client.send(new HeadObjectCommand({ Bucket: b, Key: "dst" })))
      s.record(
        "replace",
        await client.send(
          new CopyObjectCommand({
            Bucket: b,
            Key: "dst2",
            CopySource: `${b}/src%20key`,
            MetadataDirective: "REPLACE",
            Metadata: { fresh: "yes" },
            ContentType: "text/csv",
            TaggingDirective: "REPLACE",
            Tagging: "t=1",
          }),
        ),
      )
      s.record("head2", await client.send(new HeadObjectCommand({ Bucket: b, Key: "dst2" })))
      s.record(
        "precondition-error",
        await s.errorName(() =>
          client.send(
            new CopyObjectCommand({
              Bucket: b,
              Key: "dst3",
              CopySource: `${b}/src%20key`,
              CopySourceIfMatch: NO_ETAG,
            }),
          ),
        ),
      )
      s.record(
        "self-copy-error",
        await s.errorName(() =>
          client.send(new CopyObjectCommand({ Bucket: b, Key: "dst", CopySource: `${b}/dst` })),
        ),
      )
    },
  },
  {
    name: "source-odd-forms",
    async run(s) {
      const b = await s.bucket("copy-odd")
      await put(s, b, "src")
      await put(s, b, "dir/x", "dir x")
      await copy(s, "fragment", b, "d1", `${b}/src#frag`)
      await copy(s, "other-query", b, "d2", `${b}/src?foo=bar`)
      await copy(s, "version-and-other", b, "d3", `${b}/src?foo=1&versionId=null`)
      await copy(s, "double-slash-key", b, "d4", `${b}//src`)
      await copy(s, "dot-dot-key", b, "d5", `${b}/dir/../src`)
      await copy(s, "leading-dot-dot", b, "d6", `${b}//dir/../src`)
      await copy(s, "inner-double-slash", b, "d7", `${b}/dir//x`)
      await copy(s, "dot-segment", b, "d8", `${b}/./src`)
      await copy(s, "scheme", b, "d9", `http://host/${b}/src`)
      await copy(s, "colon-in-bucket", b, "d10", `a:b/src`)
      await copy(s, "bad-escape-in-query", b, "d11", `${b}/src?versionId=%zz`)
      await copy(s, "encoded-question", b, "d12", `${b}/src%3FversionId=null`)
    },
  },
  {
    name: "destination-version-id",
    async run(s) {
      const b = await s.bucket("copy-dstvid")
      await put(s, b, "src")
      await s.req("not-uuid", {
        method: "PUT",
        path: keyPath(b, "dst"),
        query: { versionId: "abc" },
        headers: { "x-amz-copy-source": `${b}/src` },
      })
      await s.req("unversioned", {
        method: "PUT",
        path: keyPath(b, "dst"),
        query: { versionId: MISSING_UUID },
        headers: { "x-amz-copy-source": `${b}/src` },
      })
      await s.req("null", {
        method: "PUT",
        path: keyPath(b, "dst"),
        query: { versionId: "null" },
        headers: { "x-amz-copy-source": `${b}/src` },
      })
    },
  },
  {
    name: "checksum-type-header",
    async run(s) {
      const b = await s.bucket("copy-ckstype")
      await put(s, b, "src", "checksum me")
      await copy(s, "crc32-full", b, "d1", `${b}/src`, {
        "x-amz-checksum-algorithm": "CRC32",
        "x-amz-checksum-type": "FULL_OBJECT",
      })
      await copy(s, "crc32-composite", b, "d2", `${b}/src`, {
        "x-amz-checksum-algorithm": "CRC32",
        "x-amz-checksum-type": "COMPOSITE",
      })
      await copy(s, "sha256-full", b, "d3", `${b}/src`, {
        "x-amz-checksum-algorithm": "SHA256",
        "x-amz-checksum-type": "FULL_OBJECT",
      })
      await copy(s, "bogus-type", b, "d4", `${b}/src`, {
        "x-amz-checksum-algorithm": "CRC32C",
        "x-amz-checksum-type": "BOGUS",
      })
      await copy(s, "type-only", b, "d5", `${b}/src`, { "x-amz-checksum-type": "FULL_OBJECT" })
    },
  },
  {
    name: "metadata-replace-edge-headers",
    async run(s) {
      const b = await s.bucket("copy-mdedge")
      await put(s, b, "src", "x", { "x-amz-meta-a": "1" })
      await copy(s, "bad-expires", b, "d1", `${b}/src`, {
        "x-amz-metadata-directive": "REPLACE",
        expires: "tomorrow",
      })
      await head(s, "head-d1", b, "d1")
      await copy(s, "aws-chunked", b, "d2", `${b}/src`, {
        "x-amz-metadata-directive": "REPLACE",
        "content-encoding": "aws-chunked,gzip",
      })
      await head(s, "head-d2", b, "d2")
      await copy(s, "only-aws-chunked", b, "d3", `${b}/src`, {
        "x-amz-metadata-directive": "REPLACE",
        "content-encoding": "aws-chunked",
      })
      await head(s, "head-d3", b, "d3")
      await copy(s, "minio-meta", b, "d4", `${b}/src`, {
        "x-amz-metadata-directive": "REPLACE",
        "x-amz-meta-empty": "",
        "x-amz-meta-spaces": "  padded  ",
      })
      await head(s, "head-d4", b, "d4")
    },
  },
  {
    name: "tagging-limits",
    async run(s) {
      const b = await s.bucket("copy-taglim")
      await put(s, b, "src")
      const eleven = Array.from({ length: 11 }, (_, index) => `k${index}=v`).join("&")
      const ten = Array.from({ length: 10 }, (_, index) => `k${index}=v`).join("&")
      await copy(s, "eleven", b, "d1", `${b}/src`, {
        "x-amz-tagging-directive": "REPLACE",
        "x-amz-tagging": eleven,
      })
      await copy(s, "ten", b, "d2", `${b}/src`, {
        "x-amz-tagging-directive": "REPLACE",
        "x-amz-tagging": ten,
      })
      await copy(s, "bad-value", b, "d3", `${b}/src`, {
        "x-amz-tagging-directive": "REPLACE",
        "x-amz-tagging": "k=a%23b",
      })
      await copy(s, "empty-key", b, "d4", `${b}/src`, {
        "x-amz-tagging-directive": "REPLACE",
        "x-amz-tagging": "=v",
      })
      await copy(s, "no-value", b, "d5", `${b}/src`, {
        "x-amz-tagging-directive": "REPLACE",
        "x-amz-tagging": "k&j=",
      })
      await head(s, "head-d5", b, "d5")
      await copy(s, "metadata-replace-unvalidated", b, "d6", `${b}/src`, {
        "x-amz-metadata-directive": "REPLACE",
        "x-amz-tagging": "a=1&a=2",
      })
    },
  },
  {
    name: "precedence",
    async run(s) {
      const b = await s.bucket("copy-prec")
      await put(s, b, "src")
      // Invalid version id beats every directive check.
      await copy(s, "version-before-directive", b, "d", `${b}/src?versionId=bad`, {
        "x-amz-metadata-directive": "X",
      })
      // Storage class is checked before the source is read.
      await copy(s, "storage-class-before-source", b, "d", `${s.name("copy-gone")}/k`, {
        "x-amz-storage-class": "X",
      })
      // The source is read (and its preconditions checked) before the tags are parsed.
      await copy(s, "precondition-before-tags", b, "d", `${b}/src`, {
        "x-amz-copy-source-if-match": NO_ETAG,
        "x-amz-tagging-directive": "REPLACE",
        "x-amz-tagging": "a=1&a=2",
      })
      await copy(s, "source-before-tags", b, "d", `${b}/nope`, {
        "x-amz-tagging-directive": "REPLACE",
        "x-amz-tagging": "a=1&a=2",
      })
      // Tags are parsed before the self-copy rule... but a tag REPLACE makes the self-copy legal.
      await copy(s, "tags-on-self", b, "src", `${b}/src`, {
        "x-amz-tagging-directive": "REPLACE",
        "x-amz-tagging": "a=1&a=2",
      })
      // The destination bucket is checked last.
      await copy(s, "missing-destination-after-tags", s.name("copy-gone-dst"), "d", `${b}/src`, {
        "x-amz-tagging-directive": "REPLACE",
        "x-amz-tagging": "a=1&a=2",
      })
    },
  },
]
