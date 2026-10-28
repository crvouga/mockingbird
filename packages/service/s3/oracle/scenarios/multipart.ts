import { createHash } from "node:crypto"
import {
  AbortMultipartUploadCommand,
  GetObjectCommand,
  HeadObjectCommand,
} from "@aws-sdk/client-s3"
import { Upload } from "@aws-sdk/lib-storage"
import { checksums } from "../client.js"
import { type Ctx, keyPath, type Scenario } from "../harness.js"

const MiB = 1024 * 1024
const XMLNS = "http://s3.amazonaws.com/doc/2006-03-01/"
/** A deterministic body of `size` bytes. */
const filled = (size: number, seed: number) => {
  const bytes = new Uint8Array(size)
  for (let index = 0; index < size; index++) bytes[index] = (index * 31 + seed * 7) & 0xff
  return bytes
}
const md5 = (bytes: Uint8Array | string) => createHash("md5").update(bytes).digest("hex")
const md5b64 = (bytes: Uint8Array | string) => createHash("md5").update(bytes).digest("base64")
/** A base64url id that decodes but names no upload. */
const FAKE_ID = Buffer.from(
  "00000000-0000-0000-0000-000000000000.11111111-2222-3333-4444-555555555555x1700000000000000000",
).toString("base64url")

type PartSpec = { n: number | string; etag?: string; extra?: string }
const completeXml = (parts: PartSpec[], ns = true) =>
  `<CompleteMultipartUpload${ns ? ` xmlns="${XMLNS}"` : ""}>${parts
    .map(
      ({ n, etag, extra }) =>
        `<Part><PartNumber>${n}</PartNumber>${etag === undefined ? "" : `<ETag>${etag}</ETag>`}${extra ?? ""}</Part>`,
    )
    .join("")}</CompleteMultipartUpload>`

const initiate = async (
  s: Ctx,
  bucket: string,
  key: string,
  headers: Record<string, string> = {},
) => {
  const res = await s.raw({
    method: "POST",
    path: keyPath(bucket, key),
    query: { uploads: "" },
    headers,
  })
  const id = res.tag("UploadId")
  if (!id) throw new Error(`setup: initiate ${key} -> ${res.status} ${res.text}`)
  return id
}
const putPart = (
  s: Ctx,
  bucket: string,
  key: string,
  uploadId: string,
  partNumber: number,
  body: string | Uint8Array,
  headers: Record<string, string> = {},
) =>
  s.raw({
    method: "PUT",
    path: keyPath(bucket, key),
    query: { partNumber: String(partNumber), uploadId },
    body,
    headers,
  })
const complete = (
  step: string,
  s: Ctx,
  bucket: string,
  key: string,
  uploadId: string,
  body: string,
  headers: Record<string, string> = {},
) => s.req(step, { method: "POST", path: keyPath(bucket, key), query: { uploadId }, body, headers })

export const scenarios: Scenario[] = [
  // ── CreateMultipartUpload ─────────────────────────────────────────────────
  {
    name: "initiate-basic",
    async run(s) {
      const b = await s.bucket("mp-init")
      const res = await s.req("initiate", {
        method: "POST",
        path: keyPath(b, "dir/a b+c.txt"),
        query: { uploads: "" },
      })
      const id = res.tag("UploadId") as string
      await s.req("list parts empty", {
        method: "GET",
        path: keyPath(b, "dir/a b+c.txt"),
        query: { uploadId: id },
      })
      await s.req("list uploads", { method: "GET", path: keyPath(b), query: { uploads: "" } })
      await s.req("head object absent", { method: "HEAD", path: keyPath(b, "dir/a b+c.txt") })
      await s.req("list objects absent", {
        method: "GET",
        path: keyPath(b),
        query: { "list-type": "2" },
      })
    },
  },
  {
    name: "initiate-special-keys",
    async run(s) {
      const b = await s.bucket("mp-keys")
      for (const key of [
        "ünïcødé/文件.bin",
        "a&b<c>'\"",
        "trailing/",
        "with%25percent",
        "sp ace/tab\there",
        "~!@$^*()=;,",
      ])
        await s.req(`initiate ${key}`, {
          method: "POST",
          path: keyPath(b, key),
          query: { uploads: "" },
        })
      await s.req("list uploads", { method: "GET", path: keyPath(b), query: { uploads: "" } })
      const long = "k".repeat(1025)
      await s.req("initiate long key", {
        method: "POST",
        path: keyPath(b, long),
        query: { uploads: "" },
      })
      await s.req("part trailing slash", {
        method: "PUT",
        path: keyPath(b, "trailing/"),
        query: { partNumber: "1", uploadId: FAKE_ID },
        body: "x",
      })
      await s.req("list parts long key", {
        method: "GET",
        path: keyPath(b, long),
        query: { uploadId: FAKE_ID },
      })
      await s.req("abort trailing slash", {
        method: "DELETE",
        path: keyPath(b, "trailing/"),
        query: { uploadId: FAKE_ID },
      })
      await s.req("complete trailing slash", {
        method: "POST",
        path: keyPath(b, "trailing/"),
        query: { uploadId: FAKE_ID },
        body: completeXml([{ n: 1, etag: md5("x") }]),
      })
      await s.req("list uploads url", {
        method: "GET",
        path: keyPath(b),
        query: { uploads: "", "encoding-type": "url" },
      })
    },
  },
  {
    name: "initiate-missing-bucket",
    async run(s) {
      const b = s.name("mp-nobucket")
      await s.req("initiate", { method: "POST", path: keyPath(b, "k"), query: { uploads: "" } })
      await s.req("initiate bad storage class", {
        method: "POST",
        path: keyPath(b, "k"),
        query: { uploads: "" },
        headers: { "x-amz-storage-class": "NOPE" },
      })
      await s.req("initiate bad tagging", {
        method: "POST",
        path: keyPath(b, "k"),
        query: { uploads: "" },
        headers: { "x-amz-tagging": "a=1&a=2" },
      })
      await s.req("initiate bad checksum", {
        method: "POST",
        path: keyPath(b, "k"),
        query: { uploads: "" },
        headers: { "x-amz-checksum-algorithm": "MD5" },
      })
      await s.req("initiate lock headers", {
        method: "POST",
        path: keyPath(b, "k"),
        query: { uploads: "" },
        headers: { "x-amz-object-lock-legal-hold": "ON" },
      })
      await s.req("list uploads", { method: "GET", path: keyPath(b), query: { uploads: "" } })
      await s.req("list uploads with prefix", {
        method: "GET",
        path: keyPath(b),
        query: { uploads: "", prefix: "k" },
      })
      await s.req("list uploads bad max", {
        method: "GET",
        path: keyPath(b),
        query: { uploads: "", "max-uploads": "x" },
      })
      await s.req("upload part 0", {
        method: "PUT",
        path: keyPath(b, "k"),
        query: { partNumber: "0", uploadId: FAKE_ID },
        body: "x",
      })
      await s.req("upload part malformed id", {
        method: "PUT",
        path: keyPath(b, "k"),
        query: { partNumber: "1", uploadId: "!!" },
        body: "x",
      })
      await s.req("list parts malformed id", {
        method: "GET",
        path: keyPath(b, "k"),
        query: { uploadId: "!!" },
      })
      await s.req("complete malformed id", {
        method: "POST",
        path: keyPath(b, "k"),
        query: { uploadId: "!!" },
        body: completeXml([{ n: 1, etag: md5("x") }]),
      })
      await s.req("complete bad xml", {
        method: "POST",
        path: keyPath(b, "k"),
        query: { uploadId: FAKE_ID },
        body: "<x",
      })
      await s.req("abort malformed id", {
        method: "DELETE",
        path: keyPath(b, "k"),
        query: { uploadId: "!!" },
      })
      await s.req("upload part", {
        method: "PUT",
        path: keyPath(b, "k"),
        query: { partNumber: "1", uploadId: FAKE_ID },
        body: "x",
      })
      await s.req("list parts", {
        method: "GET",
        path: keyPath(b, "k"),
        query: { uploadId: FAKE_ID },
      })
      await s.req("complete", {
        method: "POST",
        path: keyPath(b, "k"),
        query: { uploadId: FAKE_ID },
        body: completeXml([{ n: 1, etag: md5("x") }]),
      })
      await s.req("abort", {
        method: "DELETE",
        path: keyPath(b, "k"),
        query: { uploadId: FAKE_ID },
      })
    },
  },
  {
    name: "initiate-metadata",
    async run(s) {
      const b = await s.bucket("mp-meta")
      const headers = {
        "content-type": "text/csv; charset=utf-8",
        "content-encoding": "identity",
        "content-disposition": 'attachment; filename="x.csv"',
        "content-language": "fr-CA",
        "cache-control": "max-age=60",
        expires: "Wed, 21 Oct 2037 07:28:00 GMT",
        "x-amz-meta-color": "Blue",
        "x-amz-meta-Mixed-Case": "Value With Spaces",
        "x-amz-website-redirect-location": "/other",
      }
      const res = await s.req("initiate", {
        method: "POST",
        path: keyPath(b, "m.csv"),
        query: { uploads: "" },
        headers,
      })
      const id = res.tag("UploadId") as string
      await s.req("part", {
        method: "PUT",
        path: keyPath(b, "m.csv"),
        query: { partNumber: "1", uploadId: id },
        body: "a,b\n1,2\n",
      })
      await complete(
        "complete",
        s,
        b,
        "m.csv",
        id,
        completeXml([{ n: 1, etag: `"${md5("a,b\n1,2\n")}"` }]),
      )
      await s.req("head", { method: "HEAD", path: keyPath(b, "m.csv") })
      await s.req("get", { method: "GET", path: keyPath(b, "m.csv") })
    },
  },
  {
    name: "initiate-content-type-guess",
    async run(s) {
      const b = await s.bucket("mp-ctype")
      for (const key of ["page.html", "data.json", "noext", "image.PNG"]) {
        const id = await initiate(s, b, key)
        const etag = (await putPart(s, b, key, id, 1, "body")).headers.get("etag") as string
        await complete(`complete ${key}`, s, b, key, id, completeXml([{ n: 1, etag }]))
        await s.req(`head ${key}`, { method: "HEAD", path: keyPath(b, key) })
      }
    },
  },
  {
    name: "initiate-storage-class",
    async run(s) {
      const b = await s.bucket("mp-sc")
      for (const sc of ["STANDARD", "REDUCED_REDUNDANCY", "GLACIER", "standard", "BOGUS", ""])
        await s.req(`initiate ${sc || "empty"}`, {
          method: "POST",
          path: keyPath(b, `k-${sc}`),
          query: { uploads: "" },
          headers: { "x-amz-storage-class": sc },
        })
      const id = await initiate(s, b, "rr", { "x-amz-storage-class": "REDUCED_REDUNDANCY" })
      await s.req("list uploads", { method: "GET", path: keyPath(b), query: { uploads: "" } })
      await s.req("list parts rr", {
        method: "GET",
        path: keyPath(b, "rr"),
        query: { uploadId: id },
      })
      const etag = (await putPart(s, b, "rr", id, 1, "rr")).headers.get("etag") as string
      await complete("complete rr", s, b, "rr", id, completeXml([{ n: 1, etag }]))
      await s.req("head rr", { method: "HEAD", path: keyPath(b, "rr") })
      await s.req("list objects", { method: "GET", path: keyPath(b), query: { "list-type": "2" } })
    },
  },
  {
    name: "initiate-tagging",
    async run(s) {
      const b = await s.bucket("mp-tags")
      const id = await initiate(s, b, "t", { "x-amz-tagging": "a=1&b=two%20words" })
      const etag = (await putPart(s, b, "t", id, 1, "tagged")).headers.get("etag") as string
      await complete("complete", s, b, "t", id, completeXml([{ n: 1, etag }]))
      await s.req("head", { method: "HEAD", path: keyPath(b, "t") })
      await s.req("get tagging", { method: "GET", path: keyPath(b, "t"), query: { tagging: "" } })
      await s.req("bad tagging", {
        method: "POST",
        path: keyPath(b, "u"),
        query: { uploads: "" },
        headers: { "x-amz-tagging": "a=1&a=2" },
      })
      await s.req("bad tag key", {
        method: "POST",
        path: keyPath(b, "u"),
        query: { uploads: "" },
        headers: { "x-amz-tagging": `${"k".repeat(129)}=v` },
      })
      await s.req("bad tag encoding", {
        method: "POST",
        path: keyPath(b, "u"),
        query: { uploads: "" },
        headers: { "x-amz-tagging": "a=%zz" },
      })
    },
  },
  {
    name: "initiate-checksum-algorithm",
    async run(s) {
      const b = await s.bucket("mp-ckalg")
      const cases: [string, string | undefined][] = [
        ["CRC32", undefined],
        ["crc32c", undefined],
        ["SHA1", undefined],
        ["SHA256", undefined],
        ["CRC64NVME", undefined],
        ["CRC32", "COMPOSITE"],
        ["CRC32", "FULL_OBJECT"],
        ["CRC32C", "FULL_OBJECT"],
        ["SHA256", "FULL_OBJECT"],
        ["SHA1", "COMPOSITE"],
        ["CRC64NVME", "COMPOSITE"],
        ["CRC64NVME", "FULL_OBJECT"],
        ["MD5", undefined],
        ["", "FULL_OBJECT"],
        ["", "COMPOSITE"],
        ["CRC32", "full_object"],
      ]
      for (const [algorithm, type] of cases) {
        const headers: Record<string, string> = {}
        if (algorithm) headers["x-amz-checksum-algorithm"] = algorithm
        if (type) headers["x-amz-checksum-type"] = type
        const res = await s.req(`initiate ${algorithm || "none"}/${type ?? "-"}`, {
          method: "POST",
          path: keyPath(b, `k-${algorithm}-${type}`),
          query: { uploads: "" },
          headers,
        })
        const id = res.tag("UploadId")
        if (id)
          await s.req(`list parts ${algorithm}/${type ?? "-"}`, {
            method: "GET",
            path: keyPath(b, `k-${algorithm}-${type}`),
            query: { uploadId: id },
          })
      }
    },
  },
  // ── UploadPart ────────────────────────────────────────────────────────────
  {
    name: "upload-part-numbers",
    async run(s) {
      const b = await s.bucket("mp-pn")
      const id = await initiate(s, b, "k")
      for (const n of [
        "0",
        "1",
        "10000",
        "10001",
        "-1",
        "abc",
        "",
        "1.5",
        "+2",
        "007",
        " 3",
        "99999999999999999999",
      ])
        await s.req(`part ${JSON.stringify(n)}`, {
          method: "PUT",
          path: keyPath(b, "k"),
          query: { partNumber: n, uploadId: id },
          body: `part ${n}`,
        })
      await s.req("list parts", { method: "GET", path: keyPath(b, "k"), query: { uploadId: id } })
    },
  },
  {
    name: "upload-part-bad-upload",
    async run(s) {
      const b = await s.bucket("mp-badup")
      const id = await initiate(s, b, "k")
      await s.req("fake id", {
        method: "PUT",
        path: keyPath(b, "k"),
        query: { partNumber: "1", uploadId: FAKE_ID },
        body: "x",
      })
      await s.req("malformed id", {
        method: "PUT",
        path: keyPath(b, "k"),
        query: { partNumber: "1", uploadId: "not!base64" },
        body: "x",
      })
      await s.req("odd length id", {
        method: "PUT",
        path: keyPath(b, "k"),
        query: { partNumber: "1", uploadId: "abcde" },
        body: "x",
      })
      await s.req("empty id", {
        method: "PUT",
        path: keyPath(b, "k"),
        query: { partNumber: "1", uploadId: "" },
        body: "x",
      })
      await s.req("wrong key", {
        method: "PUT",
        path: keyPath(b, "other"),
        query: { partNumber: "1", uploadId: id },
        body: "x",
      })
      await s.req("bad part and bad id", {
        method: "PUT",
        path: keyPath(b, "k"),
        query: { partNumber: "0", uploadId: FAKE_ID },
        body: "x",
      })
      await s.req("too many and bad id", {
        method: "PUT",
        path: keyPath(b, "k"),
        query: { partNumber: "10001", uploadId: FAKE_ID },
        body: "x",
      })
      await s.req("copy source header", {
        method: "PUT",
        path: keyPath(b, "k"),
        query: { partNumber: "1", uploadId: id },
        body: "x",
        headers: { "x-amz-copy-source": "nobucketslash" },
      })
      await s.req("wrong key list", {
        method: "GET",
        path: keyPath(b, "other"),
        query: { uploadId: id },
      })
      await s.req("ok", {
        method: "PUT",
        path: keyPath(b, "k"),
        query: { partNumber: "1", uploadId: id },
        body: "x",
      })
    },
  },
  {
    name: "upload-part-content-md5",
    async run(s) {
      const b = await s.bucket("mp-md5")
      const id = await initiate(s, b, "k")
      const q = { partNumber: "1", uploadId: id }
      await s.req("right md5", {
        method: "PUT",
        path: keyPath(b, "k"),
        query: q,
        body: "hello",
        headers: { "content-md5": md5b64("hello") },
      })
      await s.req("wrong md5", {
        method: "PUT",
        path: keyPath(b, "k"),
        query: q,
        body: "hello",
        headers: { "content-md5": md5b64("world") },
      })
      await s.req("malformed md5", {
        method: "PUT",
        path: keyPath(b, "k"),
        query: q,
        body: "hello",
        headers: { "content-md5": "nope" },
      })
      await s.req("empty md5", {
        method: "PUT",
        path: keyPath(b, "k"),
        query: q,
        body: "hello",
        headers: { "content-md5": "" },
      })
      await s.req("wrong md5 bad id", {
        method: "PUT",
        path: keyPath(b, "k"),
        query: { partNumber: "1", uploadId: FAKE_ID },
        body: "hello",
        headers: { "content-md5": md5b64("world") },
      })
      await s.req("malformed md5 bad part", {
        method: "PUT",
        path: keyPath(b, "k"),
        query: { partNumber: "0", uploadId: id },
        body: "hello",
        headers: { "content-md5": "nope" },
      })
      await s.req("list parts", { method: "GET", path: keyPath(b, "k"), query: { uploadId: id } })
    },
  },
  {
    name: "upload-part-reupload",
    async run(s) {
      const b = await s.bucket("mp-reup")
      const id = await initiate(s, b, "k")
      await s.req("first", {
        method: "PUT",
        path: keyPath(b, "k"),
        query: { partNumber: "1", uploadId: id },
        body: "first version",
      })
      await s.req("second", {
        method: "PUT",
        path: keyPath(b, "k"),
        query: { partNumber: "1", uploadId: id },
        body: "v2",
      })
      await s.req("empty part", {
        method: "PUT",
        path: keyPath(b, "k"),
        query: { partNumber: "2", uploadId: id },
      })
      await s.req("list parts", { method: "GET", path: keyPath(b, "k"), query: { uploadId: id } })
      await complete(
        "complete with old etag",
        s,
        b,
        "k",
        id,
        completeXml([{ n: 1, etag: md5("first version") }]),
      )
      await complete(
        "complete",
        s,
        b,
        "k",
        id,
        completeXml([
          { n: 1, etag: md5("v2") },
          { n: 2, etag: md5("") },
        ]),
      )
      await s.req("get", { method: "GET", path: keyPath(b, "k") })
    },
  },
  {
    name: "upload-part-checksums",
    async run(s) {
      const b = await s.bucket("mp-pck")
      const body = "checksummed part"
      const bytes = new TextEncoder().encode(body)
      const plain = await initiate(s, b, "plain")
      const q = (id: string, n: number) => ({ partNumber: String(n), uploadId: id })
      await s.req("crc32 right", {
        method: "PUT",
        path: keyPath(b, "plain"),
        query: q(plain, 1),
        body,
        headers: { "x-amz-checksum-crc32": checksums.crc32(bytes) },
      })
      await s.req("crc32 wrong", {
        method: "PUT",
        path: keyPath(b, "plain"),
        query: q(plain, 2),
        body,
        headers: { "x-amz-checksum-crc32": checksums.crc32(new TextEncoder().encode("other")) },
      })
      await s.req("sha256 right", {
        method: "PUT",
        path: keyPath(b, "plain"),
        query: q(plain, 3),
        body,
        headers: { "x-amz-checksum-sha256": checksums.sha256(bytes) },
      })
      await s.req("sha1 malformed", {
        method: "PUT",
        path: keyPath(b, "plain"),
        query: q(plain, 4),
        body,
        headers: { "x-amz-checksum-sha1": "zz" },
      })
      await s.req("list plain", {
        method: "GET",
        path: keyPath(b, "plain"),
        query: { uploadId: plain },
      })
      const crc = await initiate(s, b, "crc", { "x-amz-checksum-algorithm": "CRC32" })
      await s.req("missing checksum", {
        method: "PUT",
        path: keyPath(b, "crc"),
        query: q(crc, 1),
        body,
      })
      await s.req("other algorithm", {
        method: "PUT",
        path: keyPath(b, "crc"),
        query: q(crc, 1),
        body,
        headers: { "x-amz-checksum-sha256": checksums.sha256(bytes) },
      })
      await s.req("matching algorithm", {
        method: "PUT",
        path: keyPath(b, "crc"),
        query: q(crc, 1),
        body,
        headers: { "x-amz-checksum-crc32": checksums.crc32(bytes) },
      })
      await s.req("matching wrong value", {
        method: "PUT",
        path: keyPath(b, "crc"),
        query: q(crc, 2),
        body,
        headers: { "x-amz-checksum-crc32": "AAAAAA==" },
      })
      await s.req("sdk algorithm header", {
        method: "PUT",
        path: keyPath(b, "crc"),
        query: q(crc, 3),
        body,
        headers: {
          "x-amz-checksum-crc32": checksums.crc32(bytes),
          "x-amz-sdk-checksum-algorithm": "CRC32",
        },
      })
      await s.req("list crc", { method: "GET", path: keyPath(b, "crc"), query: { uploadId: crc } })
    },
  },
  {
    name: "upload-part-streaming",
    async run(s) {
      const b = await s.bucket("mp-stream")
      const id = await initiate(s, b, "k")
      const body = filled(200 * 1024, 3)
      await s.req("streaming signed", {
        method: "PUT",
        path: keyPath(b, "k"),
        query: { partNumber: "1", uploadId: id },
        body,
        auth: "streaming",
        chunkSize: 64 * 1024,
      })
      await s.req("unsigned trailer", {
        method: "PUT",
        path: keyPath(b, "k"),
        query: { partNumber: "2", uploadId: id },
        body: "tail",
        auth: "streaming-unsigned-trailer",
        trailer: ["x-amz-checksum-crc32", checksums.crc32(new TextEncoder().encode("tail"))],
      })
      await s.req("unsigned payload", {
        method: "PUT",
        path: keyPath(b, "k"),
        query: { partNumber: "3", uploadId: id },
        body: "unsigned",
        auth: "unsigned-payload",
      })
      await s.req("list parts", { method: "GET", path: keyPath(b, "k"), query: { uploadId: id } })
    },
  },
  // ── ListParts ─────────────────────────────────────────────────────────────
  {
    name: "list-parts-paging",
    async run(s) {
      const b = await s.bucket("mp-lp")
      const id = await initiate(s, b, "k")
      for (const n of [1, 2, 3, 5, 8]) await putPart(s, b, "k", id, n, `part-${n}`)
      const list = (step: string, extra: Record<string, string>) =>
        s.req(step, { method: "GET", path: keyPath(b, "k"), query: { uploadId: id, ...extra } })
      await list("all", {})
      await list("max 2", { "max-parts": "2" })
      await list("marker 2", { "part-number-marker": "2", "max-parts": "2" })
      await list("marker 5 max 2", { "part-number-marker": "5", "max-parts": "2" })
      await list("marker 4 absent", { "part-number-marker": "4" })
      await list("marker 8 last", { "part-number-marker": "8" })
      await list("marker 100", { "part-number-marker": "100" })
      await list("max 0", { "max-parts": "0" })
      await list("max 5 exact", { "max-parts": "5" })
      await list("max 4", { "max-parts": "4" })
      await list("max 20000", { "max-parts": "20000" })
      await list("max -1", { "max-parts": "-1" })
      await list("max abc", { "max-parts": "abc" })
      await list("marker -1", { "part-number-marker": "-1" })
      await list("marker abc", { "part-number-marker": "abc" })
      await list("empty values", { "max-parts": "", "part-number-marker": "" })
      await list("encoding url", { "encoding-type": "url" })
      await s.req("fake id", { method: "GET", path: keyPath(b, "k"), query: { uploadId: FAKE_ID } })
      await s.req("malformed id", {
        method: "GET",
        path: keyPath(b, "k"),
        query: { uploadId: "%%%" },
      })
      await s.req("bad max and fake id", {
        method: "GET",
        path: keyPath(b, "k"),
        query: { uploadId: FAKE_ID, "max-parts": "x" },
      })
    },
  },
  {
    name: "list-parts-encoding",
    async run(s) {
      const b = await s.bucket("mp-lpenc")
      const key = "dir/ä b&c?.txt"
      const id = await initiate(s, b, key)
      await putPart(s, b, key, id, 1, "x")
      await s.req("plain", { method: "GET", path: keyPath(b, key), query: { uploadId: id } })
      await s.req("url", {
        method: "GET",
        path: keyPath(b, key),
        query: { uploadId: id, "encoding-type": "url" },
      })
      await s.req("bogus encoding", {
        method: "GET",
        path: keyPath(b, key),
        query: { uploadId: id, "encoding-type": "base64" },
      })
    },
  },
  // ── AbortMultipartUpload ──────────────────────────────────────────────────
  {
    name: "abort",
    async run(s) {
      const b = await s.bucket("mp-abort")
      const id = await initiate(s, b, "k")
      await putPart(s, b, "k", id, 1, "x")
      await s.req("abort", { method: "DELETE", path: keyPath(b, "k"), query: { uploadId: id } })
      await s.req("abort again", {
        method: "DELETE",
        path: keyPath(b, "k"),
        query: { uploadId: id },
      })
      await s.req("part after abort", {
        method: "PUT",
        path: keyPath(b, "k"),
        query: { partNumber: "2", uploadId: id },
        body: "y",
      })
      await s.req("list after abort", {
        method: "GET",
        path: keyPath(b, "k"),
        query: { uploadId: id },
      })
      await complete("complete after abort", s, b, "k", id, completeXml([{ n: 1, etag: md5("x") }]))
      await s.req("list uploads after abort", {
        method: "GET",
        path: keyPath(b),
        query: { uploads: "" },
      })
      await s.req("abort fake", {
        method: "DELETE",
        path: keyPath(b, "k"),
        query: { uploadId: FAKE_ID },
      })
      await s.req("abort malformed", {
        method: "DELETE",
        path: keyPath(b, "k"),
        query: { uploadId: "***" },
      })
      await s.req("abort empty id", {
        method: "DELETE",
        path: keyPath(b, "k"),
        query: { uploadId: "" },
      })
      const other = await initiate(s, b, "k2")
      await s.req("abort wrong key", {
        method: "DELETE",
        path: keyPath(b, "k"),
        query: { uploadId: other },
      })
      await s.req("still listed", {
        method: "GET",
        path: keyPath(b, "k2"),
        query: { uploadId: other },
      })
      await s.req("abort bad max-parts", {
        method: "DELETE",
        path: keyPath(b, "k2"),
        query: { uploadId: other, "max-parts": "x" },
      })
      await s.req("abort missing bucket", {
        method: "DELETE",
        path: keyPath(s.name("mp-abort-none"), "k"),
        query: { uploadId: other },
      })
    },
  },
  {
    name: "delete-bucket-with-upload",
    async run(s) {
      const b = await s.bucket("mp-delb")
      const id = await initiate(s, b, "k")
      await s.req("delete bucket", { method: "DELETE", path: keyPath(b) })
      await s.req("abort", { method: "DELETE", path: keyPath(b, "k"), query: { uploadId: id } })
      await s.req("delete bucket after abort", { method: "DELETE", path: keyPath(b) })
    },
  },
  // ── ListMultipartUploads ──────────────────────────────────────────────────
  {
    name: "list-uploads",
    async run(s) {
      const b = await s.bucket("mp-lu")
      await initiate(s, b, "b/2")
      await initiate(s, b, "a/1")
      const same1 = await initiate(s, b, "same")
      await initiate(s, b, "same")
      await initiate(s, b, "same")
      await initiate(s, b, "c")
      const list = (step: string, extra: Record<string, string>) =>
        s.req(step, { method: "GET", path: keyPath(b), query: { uploads: "", ...extra } })
      await list("all", {})
      await list("prefix exact key", { prefix: "same" })
      await list("prefix partial", { prefix: "sa" })
      await list("prefix dir", { prefix: "a/" })
      await list("prefix a/1", { prefix: "a/1" })
      await list("delimiter", { delimiter: "/" })
      await list("prefix and delimiter", { prefix: "a/1", delimiter: "/" })
      await list("max-uploads 2", { "max-uploads": "2" })
      await list("max-uploads 2 prefix", { prefix: "same", "max-uploads": "2" })
      await list("max-uploads 0", { "max-uploads": "0" })
      await list("max-uploads -1", { "max-uploads": "-1" })
      await list("max-uploads abc", { "max-uploads": "abc" })
      await list("max-uploads empty", { "max-uploads": "" })
      await list("key-marker", { "key-marker": "b" })
      await list("key-marker with prefix", { prefix: "same", "key-marker": "same" })
      await list("key-marker not under prefix", { prefix: "same", "key-marker": "a" })
      await list("upload-id-marker", {
        prefix: "same",
        "key-marker": "same",
        "upload-id-marker": same1,
      })
      await list("upload-id-marker no key", { prefix: "same", "upload-id-marker": same1 })
      await list("upload-id-marker malformed", { prefix: "same", "upload-id-marker": "!!" })
      await list("upload-id-marker slash key", {
        prefix: "a/",
        "key-marker": "a/",
        "upload-id-marker": same1,
      })
      await list("upload-id-marker fake", { prefix: "same", "upload-id-marker": FAKE_ID })
      await list("encoding url", { "encoding-type": "url", prefix: "a/", delimiter: "/" })
      await list("encoding bogus", { "encoding-type": "nope" })
    },
  },
  {
    name: "list-uploads-empty",
    async run(s) {
      const b = await s.bucket("mp-lue")
      await s.req("empty", { method: "GET", path: keyPath(b), query: { uploads: "" } })
      await s.req("empty prefix", {
        method: "GET",
        path: keyPath(b),
        query: { uploads: "", prefix: "x" },
      })
      await s.raw({ method: "PUT", path: keyPath(b, "obj"), body: "plain object" })
      await s.req("objects are not uploads", {
        method: "GET",
        path: keyPath(b),
        query: { uploads: "" },
      })
    },
  },
  // ── CompleteMultipartUpload ───────────────────────────────────────────────
  {
    name: "complete-success",
    async run(s) {
      const b = await s.bucket("mp-done")
      const key = "big/ob ject+1.bin"
      const id = await initiate(s, b, key, {
        "content-type": "application/x-test",
        "x-amz-meta-k": "v",
      })
      const p1 = filled(5 * MiB, 1)
      const p2 = filled(5 * MiB, 2)
      await s.req("part 1", {
        method: "PUT",
        path: keyPath(b, key),
        query: { partNumber: "1", uploadId: id },
        body: p1,
      })
      await s.req("part 2", {
        method: "PUT",
        path: keyPath(b, key),
        query: { partNumber: "2", uploadId: id },
        body: p2,
      })
      await s.req("part 3", {
        method: "PUT",
        path: keyPath(b, key),
        query: { partNumber: "3", uploadId: id },
        body: "tail",
      })
      await s.req("list uploads before", {
        method: "GET",
        path: keyPath(b),
        query: { uploads: "" },
      })
      await complete(
        "complete",
        s,
        b,
        key,
        id,
        completeXml([
          { n: 1, etag: `"${md5(p1)}"` },
          { n: 2, etag: md5(p2) },
          { n: 3, etag: `"${md5("tail")}"` },
        ]),
      )
      await s.req("list uploads after", { method: "GET", path: keyPath(b), query: { uploads: "" } })
      await complete("complete twice", s, b, key, id, completeXml([{ n: 1, etag: md5(p1) }]))
      await s.req("list parts after", {
        method: "GET",
        path: keyPath(b, key),
        query: { uploadId: id },
      })
      await s.req("abort after", {
        method: "DELETE",
        path: keyPath(b, key),
        query: { uploadId: id },
      })
      await s.req("head", { method: "HEAD", path: keyPath(b, key) })
      await s.req("get", { method: "GET", path: keyPath(b, key) })
      await s.req("get range across parts", {
        method: "GET",
        path: keyPath(b, key),
        headers: { range: `bytes=${5 * MiB - 3}-${5 * MiB + 2}` },
      })
      await s.req("list objects", { method: "GET", path: keyPath(b), query: { "list-type": "2" } })
      await s.req("attributes", {
        method: "GET",
        path: keyPath(b, key),
        query: { attributes: "" },
        headers: { "x-amz-object-attributes": "ETag,ObjectParts,ObjectSize" },
      })
    },
  },
  {
    name: "complete-part-number",
    async run(s) {
      const b = await s.bucket("mp-pnget")
      const id = await initiate(s, b, "k")
      const p1 = filled(5 * MiB, 4)
      await putPart(s, b, "k", id, 1, p1)
      await putPart(s, b, "k", id, 2, "second")
      await complete(
        "complete",
        s,
        b,
        "k",
        id,
        completeXml([
          { n: 1, etag: md5(p1) },
          { n: 2, etag: md5("second") },
        ]),
      )
      await s.req("head part 1", {
        method: "HEAD",
        path: keyPath(b, "k"),
        query: { partNumber: "1" },
      })
      await s.req("head part 2", {
        method: "HEAD",
        path: keyPath(b, "k"),
        query: { partNumber: "2" },
      })
      await s.req("head part 3", {
        method: "HEAD",
        path: keyPath(b, "k"),
        query: { partNumber: "3" },
      })
      await s.req("get part 2", {
        method: "GET",
        path: keyPath(b, "k"),
        query: { partNumber: "2" },
      })
      await s.req("get part 0", {
        method: "GET",
        path: keyPath(b, "k"),
        query: { partNumber: "0" },
      })
      await s.req("get part x", {
        method: "GET",
        path: keyPath(b, "k"),
        query: { partNumber: "x" },
      })
      await s.raw({ method: "PUT", path: keyPath(b, "plain"), body: "plain" })
      await s.req("plain part 1", {
        method: "HEAD",
        path: keyPath(b, "plain"),
        query: { partNumber: "1" },
      })
      await s.req("plain part 2", {
        method: "GET",
        path: keyPath(b, "plain"),
        query: { partNumber: "2" },
      })
    },
  },
  {
    name: "complete-subset",
    async run(s) {
      const b = await s.bucket("mp-subset")
      const id = await initiate(s, b, "k")
      const p1 = filled(5 * MiB, 5)
      await putPart(s, b, "k", id, 1, p1)
      await putPart(s, b, "k", id, 2, "skipped")
      await putPart(s, b, "k", id, 5, "five")
      await complete(
        "complete 1 and 5",
        s,
        b,
        "k",
        id,
        completeXml([
          { n: 1, etag: md5(p1) },
          { n: 5, etag: md5("five") },
        ]),
      )
      await s.req("head", { method: "HEAD", path: keyPath(b, "k") })
      await s.req("head part 2", {
        method: "HEAD",
        path: keyPath(b, "k"),
        query: { partNumber: "2" },
      })
    },
  },
  {
    name: "complete-single-small",
    async run(s) {
      const b = await s.bucket("mp-single")
      const id = await initiate(s, b, "k")
      await putPart(s, b, "k", id, 7, "only")
      await complete("complete", s, b, "k", id, completeXml([{ n: 7, etag: md5("only") }], false))
      await s.req("get", { method: "GET", path: keyPath(b, "k") })
      const empty = await initiate(s, b, "empty")
      await putPart(s, b, "empty", empty, 1, "")
      await complete(
        "complete empty part",
        s,
        b,
        "empty",
        empty,
        completeXml([{ n: 1, etag: md5("") }]),
      )
      await s.req("head empty", { method: "HEAD", path: keyPath(b, "empty") })
    },
  },
  {
    name: "complete-errors",
    async run(s) {
      const b = await s.bucket("mp-cerr")
      const id = await initiate(s, b, "k")
      const p1 = filled(5 * MiB, 6)
      await putPart(s, b, "k", id, 1, p1)
      await putPart(s, b, "k", id, 2, "small")
      await putPart(s, b, "k", id, 3, "last")
      const e1 = md5(p1)
      const c = (step: string, body: string, headers: Record<string, string> = {}) =>
        complete(step, s, b, "k", id, body, headers)
      await s.req("no body", { method: "POST", path: keyPath(b, "k"), query: { uploadId: id } })
      await c("empty body", "")
      await c("malformed xml", "<CompleteMultipartUpload><Part>")
      await c("not xml", "hello")
      await c("empty list", completeXml([]))
      await c("empty list no ns", "<CompleteMultipartUpload/>")
      await c("other root", `<Foo><Part><PartNumber>9</PartNumber><ETag>${e1}</ETag></Part></Foo>`)
      await c(
        "out of order",
        completeXml([
          { n: 2, etag: md5("small") },
          { n: 1, etag: e1 },
        ]),
      )
      await c(
        "missing part",
        completeXml([
          { n: 1, etag: e1 },
          { n: 4, etag: md5("x") },
        ]),
      )
      await c("wrong etag", completeXml([{ n: 1, etag: md5("nope") }]))
      await c("garbage etag", completeXml([{ n: 1, etag: "not-an-etag" }]))
      await c("no etag", completeXml([{ n: 1 }]))
      await c("part 0", completeXml([{ n: 0, etag: e1 }]))
      await c("part abc", completeXml([{ n: "abc", etag: e1 }]))
      await c("part negative", completeXml([{ n: -1, etag: e1 }]))
      await c("part 10001", completeXml([{ n: 10001, etag: e1 }]))
      await c(
        "too small middle",
        completeXml([
          { n: 1, etag: e1 },
          { n: 2, etag: md5("small") },
          { n: 3, etag: md5("last") },
        ]),
      )
      await c(
        "too small first",
        completeXml([
          { n: 2, etag: md5("small") },
          { n: 3, etag: md5("last") },
        ]),
      )
      await c(
        "wrong etag before too small",
        completeXml([
          { n: 2, etag: md5("small") },
          { n: 3, etag: md5("bad") },
        ]),
      )
      await c("lock headers", completeXml([{ n: 1, etag: e1 }]), {
        "x-amz-object-lock-mode": "GOVERNANCE",
      })
      await c("legal hold header", completeXml([{ n: 1, etag: e1 }]), {
        "x-amz-object-lock-legal-hold": "ON",
      })
      await c("bypass header", completeXml([{ n: 1, etag: e1 }]), {
        "x-amz-bypass-governance-retention": "true",
      })
      await complete("malformed xml fake id", s, b, "k", FAKE_ID, "<bad")
      await complete(
        "out of order fake id",
        s,
        b,
        "k",
        FAKE_ID,
        completeXml([
          { n: 2, etag: e1 },
          { n: 1, etag: e1 },
        ]),
      )
      await complete("fake id", s, b, "k", FAKE_ID, completeXml([{ n: 1, etag: e1 }]))
      await complete("malformed id", s, b, "k", "@@", completeXml([{ n: 1, etag: e1 }]))
      await complete("wrong key", s, b, "other", id, completeXml([{ n: 1, etag: e1 }]))
      await s.req("bad max-parts query", {
        method: "POST",
        path: keyPath(b, "k"),
        query: { uploadId: id, "max-parts": "z" },
        body: completeXml([{ n: 1, etag: e1 }]),
      })
      await s.req("still pending", {
        method: "GET",
        path: keyPath(b, "k"),
        query: { uploadId: id },
      })
      await c(
        "finally ok",
        completeXml([
          { n: 1, etag: e1 },
          { n: 3, etag: md5("last") },
        ]),
      )
      await s.req("head", { method: "HEAD", path: keyPath(b, "k") })
      const dup = await initiate(s, b, "dup")
      await putPart(s, b, "dup", dup, 1, p1)
      await putPart(s, b, "dup", dup, 2, "two")
      await complete(
        "duplicate part numbers",
        s,
        b,
        "dup",
        dup,
        completeXml([
          { n: 1, etag: e1 },
          { n: 1, etag: e1 },
          { n: 2, etag: md5("two") },
        ]),
      )
      await s.req("head duplicate", { method: "HEAD", path: keyPath(b, "dup") })
      await s.req("get duplicate tail", {
        method: "GET",
        path: keyPath(b, "dup"),
        headers: { range: "bytes=-5" },
      })
      const huge = await initiate(s, b, "huge")
      await complete(
        "part number overflow",
        s,
        b,
        "huge",
        huge,
        completeXml([{ n: "99999999999999999999", etag: e1 }]),
      )
      await complete(
        "part number spaces",
        s,
        b,
        "huge",
        huge,
        completeXml([{ n: " 1 ", etag: e1 }]),
      )
      await complete("part number empty", s, b, "huge", huge, completeXml([{ n: "", etag: e1 }]))
      await complete(
        "mismatched tags",
        s,
        b,
        "huge",
        huge,
        "<CompleteMultipartUpload><Part></Prt></CompleteMultipartUpload>",
      )
      await complete("stray end tag", s, b, "huge", huge, "</CompleteMultipartUpload>")
      await complete(
        "multiline eof",
        s,
        b,
        "huge",
        huge,
        "<CompleteMultipartUpload>\n<Part>\n<PartNumber>1",
      )
    },
  },
  {
    name: "complete-conditional",
    async run(s) {
      const b = await s.bucket("mp-cond")
      const etag = (k: string, id: string, body: string) =>
        putPart(s, b, k, id, 1, body).then((r) => r.headers.get("etag") as string)
      const a = await initiate(s, b, "k")
      const ea = await etag("k", a, "aaa")
      await complete("if-none-match on missing", s, b, "k", a, completeXml([{ n: 1, etag: ea }]), {
        "if-none-match": "*",
      })
      const second = await initiate(s, b, "k")
      const e2 = await etag("k", second, "bbb")
      await complete(
        "if-none-match on existing",
        s,
        b,
        "k",
        second,
        completeXml([{ n: 1, etag: e2 }]),
        { "if-none-match": "*" },
      )
      await complete("if-match wrong", s, b, "k", second, completeXml([{ n: 1, etag: e2 }]), {
        "if-match": '"0123456789abcdef0123456789abcdef"',
      })
      const current = (await s.raw({ method: "HEAD", path: keyPath(b, "k") })).headers.get(
        "etag",
      ) as string
      await complete("if-match right", s, b, "k", second, completeXml([{ n: 1, etag: e2 }]), {
        "if-match": current,
      })
      const third = await initiate(s, b, "missing")
      const e3 = await etag("missing", third, "ccc")
      await complete(
        "if-match on missing",
        s,
        b,
        "missing",
        third,
        completeXml([{ n: 1, etag: e3 }]),
        { "if-match": "*" },
      )
      await complete(
        "if-none-match etag on missing",
        s,
        b,
        "missing",
        third,
        completeXml([{ n: 1, etag: e3 }]),
        { "if-none-match": '"abc"' },
      )
      const init = await s.req("initiate if-none-match existing", {
        method: "POST",
        path: keyPath(b, "k"),
        query: { uploads: "" },
        headers: { "if-none-match": "*" },
      })
      await s.req("initiate if-match wrong", {
        method: "POST",
        path: keyPath(b, "k"),
        query: { uploads: "" },
        headers: { "if-match": '"nope"' },
      })
      await s.req("initiate if-match missing", {
        method: "POST",
        path: keyPath(b, "zzz"),
        query: { uploads: "" },
        headers: { "if-match": "*" },
      })
      if (init.status === 200)
        await s.raw({
          method: "DELETE",
          path: keyPath(b, "k"),
          query: { uploadId: init.tag("UploadId") as string },
        })
    },
  },
  {
    name: "complete-checksum-composite",
    async run(s) {
      const b = await s.bucket("mp-ckc")
      const enc = new TextEncoder()
      const p1 = filled(5 * MiB, 7)
      const p2 = enc.encode("second part")
      const id = await initiate(s, b, "k", { "x-amz-checksum-algorithm": "CRC32" })
      const c1 = checksums.crc32(p1)
      const c2 = checksums.crc32(p2)
      await s.req("part 1", {
        method: "PUT",
        path: keyPath(b, "k"),
        query: { partNumber: "1", uploadId: id },
        body: p1,
        headers: { "x-amz-checksum-crc32": c1 },
      })
      await s.req("part 2", {
        method: "PUT",
        path: keyPath(b, "k"),
        query: { partNumber: "2", uploadId: id },
        body: p2,
        headers: { "x-amz-checksum-crc32": c2 },
      })
      await s.req("list parts", { method: "GET", path: keyPath(b, "k"), query: { uploadId: id } })
      const cx = (a: string, z: string) => [
        { n: 1, etag: md5(p1), extra: a },
        { n: 2, etag: md5(p2), extra: z },
      ]
      await complete(
        "missing part checksums",
        s,
        b,
        "k",
        id,
        completeXml([
          { n: 1, etag: md5(p1) },
          { n: 2, etag: md5(p2) },
        ]),
      )
      await complete(
        "wrong part checksum",
        s,
        b,
        "k",
        id,
        completeXml(
          cx(`<ChecksumCRC32>${c1}</ChecksumCRC32>`, `<ChecksumCRC32>${c1}</ChecksumCRC32>`),
        ),
      )
      await complete(
        "other algorithm element",
        s,
        b,
        "k",
        id,
        completeXml(
          cx(`<ChecksumSHA256>${c1}</ChecksumSHA256>`, `<ChecksumSHA256>${c2}</ChecksumSHA256>`),
        ),
      )
      await complete(
        "header type mismatch",
        s,
        b,
        "k",
        id,
        completeXml(
          cx(`<ChecksumCRC32>${c1}</ChecksumCRC32>`, `<ChecksumCRC32>${c2}</ChecksumCRC32>`),
        ),
        { "x-amz-checksum-sha256": checksums.sha256(p2) },
      )
      await complete(
        "header wrong value",
        s,
        b,
        "k",
        id,
        completeXml(
          cx(`<ChecksumCRC32>${c1}</ChecksumCRC32>`, `<ChecksumCRC32>${c2}</ChecksumCRC32>`),
        ),
        { "x-amz-checksum-crc32": "AAAAAA==-2" },
      )
      await complete(
        "complete",
        s,
        b,
        "k",
        id,
        completeXml(
          cx(`<ChecksumCRC32>${c1}</ChecksumCRC32>`, `<ChecksumCRC32>${c2}</ChecksumCRC32>`),
        ),
      )
      await s.req("head", { method: "HEAD", path: keyPath(b, "k") })
      await s.req("head checksum mode", {
        method: "HEAD",
        path: keyPath(b, "k"),
        headers: { "x-amz-checksum-mode": "ENABLED" },
      })
      await s.req("head part 2 checksum mode", {
        method: "HEAD",
        path: keyPath(b, "k"),
        query: { partNumber: "2" },
        headers: { "x-amz-checksum-mode": "ENABLED" },
      })
      const sha = await initiate(s, b, "sha", { "x-amz-checksum-algorithm": "SHA256" })
      const s1 = checksums.sha256(p2)
      await putPart(s, b, "sha", sha, 1, p2, { "x-amz-checksum-sha256": s1 })
      await complete(
        "complete sha256",
        s,
        b,
        "sha",
        sha,
        completeXml([{ n: 1, etag: md5(p2), extra: `<ChecksumSHA256>${s1}</ChecksumSHA256>` }]),
      )
      await s.req("head sha256", {
        method: "HEAD",
        path: keyPath(b, "sha"),
        headers: { "x-amz-checksum-mode": "ENABLED" },
      })
      const plain = await initiate(s, b, "plain")
      await putPart(s, b, "plain", plain, 1, p2, { "x-amz-checksum-crc32": c2 })
      await complete(
        "plain upload with part checksum",
        s,
        b,
        "plain",
        plain,
        completeXml([{ n: 1, etag: md5(p2), extra: `<ChecksumCRC32>${c2}</ChecksumCRC32>` }]),
      )
      await s.req("head plain", {
        method: "HEAD",
        path: keyPath(b, "plain"),
        headers: { "x-amz-checksum-mode": "ENABLED" },
      })
    },
  },
  {
    name: "complete-checksum-full-object",
    async run(s) {
      const b = await s.bucket("mp-ckf")
      const enc = new TextEncoder()
      const p1 = filled(5 * MiB, 8)
      const p2 = enc.encode("full object tail")
      const whole = new Uint8Array(p1.length + p2.length)
      whole.set(p1)
      whole.set(p2, p1.length)
      const id = await initiate(s, b, "k", {
        "x-amz-checksum-algorithm": "CRC32",
        "x-amz-checksum-type": "FULL_OBJECT",
      })
      const c1 = checksums.crc32(p1)
      const c2 = checksums.crc32(p2)
      await s.req("part 1", {
        method: "PUT",
        path: keyPath(b, "k"),
        query: { partNumber: "1", uploadId: id },
        body: p1,
        headers: { "x-amz-checksum-crc32": c1 },
      })
      await s.req("part 2", {
        method: "PUT",
        path: keyPath(b, "k"),
        query: { partNumber: "2", uploadId: id },
        body: p2,
        headers: { "x-amz-checksum-crc32": c2 },
      })
      const parts = completeXml([
        { n: 1, etag: md5(p1), extra: `<ChecksumCRC32>${c1}</ChecksumCRC32>` },
        { n: 2, etag: md5(p2), extra: `<ChecksumCRC32>${c2}</ChecksumCRC32>` },
      ])
      await complete("wrong full checksum", s, b, "k", id, parts, {
        "x-amz-checksum-crc32": c1,
        "x-amz-checksum-type": "FULL_OBJECT",
      })
      await complete("complete", s, b, "k", id, parts, {
        "x-amz-checksum-crc32": checksums.crc32(whole),
        "x-amz-checksum-type": "FULL_OBJECT",
      })
      await s.req("head checksum mode", {
        method: "HEAD",
        path: keyPath(b, "k"),
        headers: { "x-amz-checksum-mode": "ENABLED" },
      })
      const nv = await initiate(s, b, "nv", { "x-amz-checksum-algorithm": "CRC64NVME" })
      await s.req("crc64 part without checksum", {
        method: "PUT",
        path: keyPath(b, "nv"),
        query: { partNumber: "1", uploadId: nv },
        body: p2,
      })
    },
  },
  {
    name: "complete-versioned",
    async run(s) {
      const b = await s.bucket("mp-ver", { versioning: "Enabled" })
      const id = await initiate(s, b, "k")
      await putPart(s, b, "k", id, 1, "v1")
      await complete("complete v1", s, b, "k", id, completeXml([{ n: 1, etag: md5("v1") }]))
      const id2 = await initiate(s, b, "k")
      await putPart(s, b, "k", id2, 1, "v2")
      await complete("complete v2", s, b, "k", id2, completeXml([{ n: 1, etag: md5("v2") }]))
      await s.req("versions", { method: "GET", path: keyPath(b), query: { versions: "" } })
      await s.req("get", { method: "GET", path: keyPath(b, "k") })
      const susp = await s.bucket("mp-susp", { versioning: "Suspended" })
      const id3 = await initiate(s, susp, "k")
      await putPart(s, susp, "k", id3, 1, "s")
      await complete(
        "complete suspended",
        s,
        susp,
        "k",
        id3,
        completeXml([{ n: 1, etag: md5("s") }]),
      )
    },
  },
  // ── UploadPartCopy ────────────────────────────────────────────────────────
  {
    name: "upload-part-copy",
    async run(s) {
      const b = await s.bucket("mp-copy")
      const src = filled(6 * MiB, 9)
      await s.raw({ method: "PUT", path: keyPath(b, "src"), body: src })
      await s.raw({ method: "PUT", path: keyPath(b, "small src"), body: "0123456789" })
      const id = await initiate(s, b, "dst")
      const q = (n: number, uploadId = id) => ({ partNumber: String(n), uploadId })
      const copy = (
        step: string,
        n: number,
        headers: Record<string, string>,
        uploadId = id,
        key = "dst",
      ) => s.req(step, { method: "PUT", path: keyPath(b, key), query: q(n, uploadId), headers })
      const source = `/${b}/src`
      await copy("whole", 1, { "x-amz-copy-source": source })
      await copy("range", 2, {
        "x-amz-copy-source": `${b}/small%20src`,
        "x-amz-copy-source-range": "bytes=2-5",
      })
      await copy("range single byte", 3, {
        "x-amz-copy-source": `${b}/small%20src`,
        "x-amz-copy-source-range": "bytes=9-9",
      })
      await copy("range open end", 4, {
        "x-amz-copy-source": `${b}/small%20src`,
        "x-amz-copy-source-range": "bytes=2-",
      })
      await copy("range suffix", 4, {
        "x-amz-copy-source": `${b}/small%20src`,
        "x-amz-copy-source-range": "bytes=-3",
      })
      await copy("range beyond end", 4, {
        "x-amz-copy-source": `${b}/small%20src`,
        "x-amz-copy-source-range": "bytes=5-10",
      })
      await copy("range start beyond", 4, {
        "x-amz-copy-source": `${b}/small%20src`,
        "x-amz-copy-source-range": "bytes=10-12",
      })
      await copy("range reversed", 4, {
        "x-amz-copy-source": `${b}/small%20src`,
        "x-amz-copy-source-range": "bytes=5-2",
      })
      await copy("range garbage", 4, {
        "x-amz-copy-source": `${b}/small%20src`,
        "x-amz-copy-source-range": "pages=1-2",
      })
      await copy("range empty", 4, {
        "x-amz-copy-source": `${b}/small%20src`,
        "x-amz-copy-source-range": "",
      })
      await copy("range multi", 4, {
        "x-amz-copy-source": `${b}/small%20src`,
        "x-amz-copy-source-range": "bytes=0-1,3-4",
      })
      await copy("missing source key", 4, { "x-amz-copy-source": `${b}/nope` })
      await copy("missing source bucket", 4, {
        "x-amz-copy-source": `${s.name("mp-copy-none")}/src`,
      })
      await copy("source bucket only", 4, { "x-amz-copy-source": `${b}/` })
      await copy("bad version id", 4, { "x-amz-copy-source": `${b}/src?versionId=nope` })
      await copy("null version id", 4, { "x-amz-copy-source": `${b}/small%20src?versionId=null` })
      await copy("uuid version id", 4, {
        "x-amz-copy-source": `${b}/small%20src?versionId=11111111-2222-4333-8444-555555555555`,
      })
      await copy("part 0", 0, { "x-amz-copy-source": source })
      await copy("part 10001", 10001, { "x-amz-copy-source": source })
      await copy("fake upload", 4, { "x-amz-copy-source": source }, FAKE_ID)
      await copy("malformed upload", 4, { "x-amz-copy-source": source }, "!")
      await copy("wrong key", 4, { "x-amz-copy-source": source }, id, "other")
      await copy("missing source and fake upload", 4, { "x-amz-copy-source": `${b}/nope` }, FAKE_ID)
      await s.req("list parts", { method: "GET", path: keyPath(b, "dst"), query: { uploadId: id } })
      await complete(
        "complete",
        s,
        b,
        "dst",
        id,
        completeXml([
          { n: 1, etag: md5(src) },
          { n: 3, etag: md5("9") },
        ]),
      )
      await s.req("get", {
        method: "GET",
        path: keyPath(b, "dst"),
        headers: { range: `bytes=${6 * MiB - 2}-` },
      })
    },
  },
  {
    name: "upload-part-copy-conditional",
    async run(s) {
      const b = await s.bucket("mp-copyc")
      const put = await s.raw({
        method: "PUT",
        path: keyPath(b, "src"),
        body: "conditional source",
      })
      const etag = put.headers.get("etag") as string
      const id = await initiate(s, b, "dst")
      const copy = (step: string, headers: Record<string, string>) =>
        s.req(step, {
          method: "PUT",
          path: keyPath(b, "dst"),
          query: { partNumber: "1", uploadId: id },
          headers: { "x-amz-copy-source": `${b}/src`, ...headers },
        })
      await copy("if-match right", { "x-amz-copy-source-if-match": etag })
      await copy("if-match unquoted", { "x-amz-copy-source-if-match": etag.replace(/"/g, "") })
      await copy("if-match wrong", { "x-amz-copy-source-if-match": '"abc"' })
      await copy("if-none-match right", { "x-amz-copy-source-if-none-match": etag })
      await copy("if-none-match other", { "x-amz-copy-source-if-none-match": '"abc"' })
      await copy("if-modified-since future", {
        "x-amz-copy-source-if-modified-since": "Fri, 01 Jan 2100 00:00:00 GMT",
      })
      await copy("if-modified-since past", {
        "x-amz-copy-source-if-modified-since": "Mon, 01 Jan 2001 00:00:00 GMT",
      })
      await copy("if-unmodified-since past", {
        "x-amz-copy-source-if-unmodified-since": "Mon, 01 Jan 2001 00:00:00 GMT",
      })
      await copy("if-unmodified-since future", {
        "x-amz-copy-source-if-unmodified-since": "Fri, 01 Jan 2100 00:00:00 GMT",
      })
      await copy("if-match and unmodified past", {
        "x-amz-copy-source-if-match": etag,
        "x-amz-copy-source-if-unmodified-since": "Mon, 01 Jan 2001 00:00:00 GMT",
      })
      await copy("if-none-match and modified future", {
        "x-amz-copy-source-if-none-match": '"abc"',
        "x-amz-copy-source-if-modified-since": "Fri, 01 Jan 2100 00:00:00 GMT",
      })
      await copy("if-match wrong with bad range", {
        "x-amz-copy-source-if-match": '"abc"',
        "x-amz-copy-source-range": "bytes=100-200",
      })
      await copy("bad range only", { "x-amz-copy-source-range": "bytes=100-200" })
      await copy("bad date ignored", { "x-amz-copy-source-if-modified-since": "yesterday" })
    },
  },
  {
    name: "upload-part-copy-versions",
    async run(s) {
      const b = await s.bucket("mp-copyv", { versioning: "Enabled" })
      const v1 = (
        await s.raw({ method: "PUT", path: keyPath(b, "src"), body: "version one" })
      ).headers.get("x-amz-version-id") as string
      await s.raw({ method: "PUT", path: keyPath(b, "src"), body: "version two!" })
      const id = await initiate(s, b, "dst")
      const copy = (step: string, n: number, source: string) =>
        s.req(step, {
          method: "PUT",
          path: keyPath(b, "dst"),
          query: { partNumber: String(n), uploadId: id },
          headers: { "x-amz-copy-source": source },
        })
      await copy("latest", 1, `${b}/src`)
      await copy("v1", 2, `${b}/src?versionId=${v1}`)
      await copy("missing version", 3, `${b}/src?versionId=11111111-2222-4333-8444-555555555555`)
      const marker = await s.raw({ method: "DELETE", path: keyPath(b, "src") })
      await copy("delete marker latest", 3, `${b}/src`)
      await copy(
        "delete marker by id",
        3,
        `${b}/src?versionId=${marker.headers.get("x-amz-version-id")}`,
      )
      await s.req("list parts", { method: "GET", path: keyPath(b, "dst"), query: { uploadId: id } })
    },
  },
  {
    name: "upload-part-copy-from-multipart",
    async run(s) {
      const b = await s.bucket("mp-copymp")
      const id = await initiate(s, b, "src")
      const p1 = filled(5 * MiB, 10)
      await putPart(s, b, "src", id, 1, p1)
      await putPart(s, b, "src", id, 2, "src tail")
      await complete(
        "complete src",
        s,
        b,
        "src",
        id,
        completeXml([
          { n: 1, etag: md5(p1) },
          { n: 2, etag: md5("src tail") },
        ]),
      )
      const dst = await initiate(s, b, "dst")
      await s.req("copy whole multipart", {
        method: "PUT",
        path: keyPath(b, "dst"),
        query: { partNumber: "1", uploadId: dst },
        headers: { "x-amz-copy-source": `${b}/src` },
      })
      await s.req("copy tail range", {
        method: "PUT",
        path: keyPath(b, "dst"),
        query: { partNumber: "2", uploadId: dst },
        headers: {
          "x-amz-copy-source": `${b}/src`,
          "x-amz-copy-source-range": `bytes=${5 * MiB}-${5 * MiB + 7}`,
        },
      })
      await s.req("list parts", {
        method: "GET",
        path: keyPath(b, "dst"),
        query: { uploadId: dst },
      })
    },
  },
  // ── a real client ─────────────────────────────────────────────────────────
  {
    name: "sdk-lib-storage",
    async run(s) {
      const b = await s.bucket("mp-sdk")
      const client = s.sdk()
      const body = filled(11 * MiB, 11)
      const upload = new Upload({
        client,
        params: {
          Bucket: b,
          Key: "sdk/large.bin",
          Body: body,
          ContentType: "application/x-big",
          Metadata: { origin: "lib-storage" },
        },
        partSize: 5 * MiB,
        queueSize: 1,
      })
      const result = await upload.done()
      s.record("upload result", { ...result, $metadata: undefined })
      const head = await client.send(new HeadObjectCommand({ Bucket: b, Key: "sdk/large.bin" }))
      s.record("head", { ...head, $metadata: undefined, LastModified: undefined })
      const part = await client.send(
        new GetObjectCommand({ Bucket: b, Key: "sdk/large.bin", PartNumber: 3 }),
      )
      s.record("get part 3", {
        ContentLength: part.ContentLength,
        ContentRange: part.ContentRange,
        PartsCount: part.PartsCount,
        ETag: part.ETag,
      })
      await part.Body?.transformToByteArray()
      s.record(
        "abort missing",
        await s.errorName(() =>
          client.send(
            new AbortMultipartUploadCommand({ Bucket: b, Key: "nope", UploadId: FAKE_ID }),
          ),
        ),
      )
    },
  },
  {
    name: "object-lock",
    async run(s) {
      const b = await s.bucket("mp-lock", { objectLock: true })
      const id = await initiate(s, b, "k", {
        "x-amz-object-lock-mode": "GOVERNANCE",
        "x-amz-object-lock-retain-until-date": "2099-01-01T00:00:00Z",
        "x-amz-object-lock-legal-hold": "ON",
      })
      await putPart(s, b, "k", id, 1, "locked")
      await complete("complete", s, b, "k", id, completeXml([{ n: 1, etag: md5("locked") }]))
      await s.req("head", { method: "HEAD", path: keyPath(b, "k") })
      await s.req("retention", { method: "GET", path: keyPath(b, "k"), query: { retention: "" } })
      await s.req("legal hold", {
        method: "GET",
        path: keyPath(b, "k"),
        query: { "legal-hold": "" },
      })
      await s.req("bad mode", {
        method: "POST",
        path: keyPath(b, "x"),
        query: { uploads: "" },
        headers: {
          "x-amz-object-lock-mode": "NOPE",
          "x-amz-object-lock-retain-until-date": "2099-01-01T00:00:00Z",
        },
      })
      await s.req("past date", {
        method: "POST",
        path: keyPath(b, "x"),
        query: { uploads: "" },
        headers: {
          "x-amz-object-lock-mode": "GOVERNANCE",
          "x-amz-object-lock-retain-until-date": "2001-01-01T00:00:00Z",
        },
      })
      await s.req("mode without date", {
        method: "POST",
        path: keyPath(b, "x"),
        query: { uploads: "" },
        headers: { "x-amz-object-lock-mode": "GOVERNANCE" },
      })
      const plain = await s.bucket("mp-nolock")
      await s.req("lock headers on plain bucket", {
        method: "POST",
        path: keyPath(plain, "x"),
        query: { uploads: "" },
        headers: { "x-amz-object-lock-legal-hold": "ON" },
      })
      await s.raw({
        method: "PUT",
        path: keyPath(b, "k"),
        query: { "legal-hold": "" },
        body: '<LegalHold xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Status>OFF</Status></LegalHold>',
      })
    },
  },
]
