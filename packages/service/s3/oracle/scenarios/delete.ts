/** DeleteObject and DeleteObjects (multi-object delete). */
import { createHash } from "node:crypto"
import { type Ctx, keyPath, type Scenario } from "../harness.js"
import { ABSENT_VERSION, versionOf } from "./versioning.js"

const XMLNS = "http://s3.amazonaws.com/doc/2006-03-01/"
export const md5 = (body: string) => createHash("md5").update(body).digest("base64")

const escapeXml = (value: string) =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")

export type DeleteEntry = string | { key: string; versionId?: string }

/** A `<Delete>` document. */
export const deleteBody = (entries: DeleteEntry[], quiet?: boolean | string) =>
  `<Delete xmlns="${XMLNS}">${quiet === undefined ? "" : `<Quiet>${quiet}</Quiet>`}${entries
    .map((entry) => {
      const { key, versionId } =
        typeof entry === "string" ? { key: entry, versionId: undefined } : entry
      return `<Object><Key>${escapeXml(key)}</Key>${versionId === undefined ? "" : `<VersionId>${versionId}</VersionId>`}</Object>`
    })
    .join("")}</Delete>`

/** POST ?delete with a correct Content-MD5. */
export const multiDelete = (
  s: Ctx,
  step: string,
  bucket: string,
  body: string,
  headers: Record<string, string> = {},
) =>
  s.req(step, {
    method: "POST",
    path: keyPath(bucket),
    query: { delete: "" },
    body,
    headers: { "content-md5": md5(body), ...headers },
  })

const put = (s: Ctx, bucket: string, key: string, body = key) =>
  s.raw({ method: "PUT", path: keyPath(bucket, key), body })

export const scenarios: Scenario[] = [
  {
    name: "delete-object-errors",
    async run(s) {
      const missing = s.name("del-nobucket")
      await s.req("missing bucket", { method: "DELETE", path: keyPath(missing, "k") })
      await s.req("missing bucket with version", {
        method: "DELETE",
        path: keyPath(missing, "k"),
        query: { versionId: ABSENT_VERSION },
      })
      await s.req("missing bucket bad version", {
        method: "DELETE",
        path: keyPath(missing, "k"),
        query: { versionId: "nope" },
      })
      const b = await s.bucket("del-basic")
      await s.req("missing key", { method: "DELETE", path: keyPath(b, "nothing/here") })
      await s.req("bad version id", {
        method: "DELETE",
        path: keyPath(b, "k"),
        query: { versionId: "1234" },
      })
      await s.req("version id with spaces", {
        method: "DELETE",
        path: keyPath(b, "k"),
        query: { versionId: ` ${ABSENT_VERSION} ` },
      })
      await s.req("version id braces", {
        method: "DELETE",
        path: keyPath(b, "k"),
        query: { versionId: `{${ABSENT_VERSION}}` },
      })
      await s.req("bad force-delete", {
        method: "DELETE",
        path: keyPath(b, "k"),
        headers: { "x-minio-force-delete": "maybe" },
      })
    },
  },
  {
    name: "delete-object-unversioned",
    async run(s) {
      const b = await s.bucket("del-plain")
      await put(s, b, "a.txt")
      await put(s, b, "dir/")
      await put(s, b, "dir/inner")
      await s.req("delete", { method: "DELETE", path: keyPath(b, "a.txt") })
      await s.req("head deleted", { method: "HEAD", path: keyPath(b, "a.txt") })
      await s.req("delete again", { method: "DELETE", path: keyPath(b, "a.txt") })
      await s.req("delete folder object", { method: "DELETE", path: keyPath(b, "dir/") })
      await s.req("head folder", { method: "HEAD", path: keyPath(b, "dir/") })
      await s.req("inner survives", { method: "HEAD", path: keyPath(b, "dir/inner") })
      await s.req("delete with body", {
        method: "DELETE",
        path: keyPath(b, "dir/inner"),
        body: "ignored",
      })
      await s.req("list after", { method: "GET", path: keyPath(b), query: { "list-type": "2" } })
    },
  },
  {
    name: "delete-object-versioned-folder",
    async run(s) {
      const b = await s.bucket("del-vfolder", { versioning: "Enabled" })
      const v = versionOf(
        await s.req("put folder", { method: "PUT", path: keyPath(b, "dir/"), body: "" }),
      )
      await s.req("delete folder (null only)", { method: "DELETE", path: keyPath(b, "dir/") })
      await s.req("head folder", { method: "HEAD", path: keyPath(b, "dir/") })
      await s.req("delete folder version", {
        method: "DELETE",
        path: keyPath(b, "dir/"),
        query: { versionId: v },
      })
      await s.req("head folder after", { method: "HEAD", path: keyPath(b, "dir/") })
    },
  },
  {
    name: "delete-objects-basic",
    async run(s) {
      const b = await s.bucket("del-multi")
      for (const key of ["a", "b", "c/d", "e"]) await put(s, b, key)
      await multiDelete(s, "verbose", b, deleteBody(["a", "c/d", "missing"]))
      await multiDelete(s, "quiet", b, deleteBody(["b", "nope"], true))
      await multiDelete(s, "quiet false", b, deleteBody(["e"], false))
      await multiDelete(s, "quiet garbage", b, deleteBody(["e"], "yes"))
      await s.req("list after", { method: "GET", path: keyPath(b), query: { "list-type": "2" } })
    },
  },
  {
    name: "delete-objects-request-errors",
    async run(s) {
      const b = await s.bucket("del-multierr")
      await put(s, b, "a")
      const body = deleteBody(["a"])
      const post = (
        step: string,
        spec: { body?: string; headers?: Record<string, string>; path?: string },
      ) =>
        s.req(step, {
          method: "POST",
          path: spec.path ?? keyPath(b),
          query: { delete: "" },
          ...(spec.body !== undefined ? { body: spec.body } : {}),
          headers: spec.headers ?? {},
        })
      await post("no content-md5", { body })
      await post("wrong content-md5", { body, headers: { "content-md5": md5("other") } })
      await post("crc32 checksum instead", {
        body,
        headers: { "x-amz-checksum-crc32": crc32b64(body) },
      })
      await post("wrong crc32 checksum", { body, headers: { "x-amz-checksum-crc32": "AAAAAA==" } })
      await post("checksum algorithm only", {
        body,
        headers: { "x-amz-sdk-checksum-algorithm": "CRC32" },
      })
      await post("empty body", { body: "", headers: { "content-md5": md5("") } })
      await post("not xml", { body: "hello", headers: { "content-md5": md5("hello") } })
      const truncated = `<Delete><Object><Key>a</Key></Object>`
      await post("truncated", { body: truncated, headers: { "content-md5": md5(truncated) } })
      const wrongRoot = `<Remove><Object><Key>a</Key></Object></Remove>`
      await post("wrong root", { body: wrongRoot, headers: { "content-md5": md5(wrongRoot) } })
      const none = `<Delete xmlns="${XMLNS}"></Delete>`
      await post("no objects", { body: none, headers: { "content-md5": md5(none) } })
      const quietOnly = `<Delete><Quiet>true</Quiet></Delete>`
      await post("quiet only", { body: quietOnly, headers: { "content-md5": md5(quietOnly) } })
      const tooMany = deleteBody(Array.from({ length: 1001 }, (_, i) => `k${i}`))
      await post("1001 objects", { body: tooMany, headers: { "content-md5": md5(tooMany) } })
      await post("missing bucket", {
        path: keyPath(s.name("del-nob")),
        body,
        headers: { "content-md5": md5(body) },
      })
      await s.req("still there", { method: "HEAD", path: keyPath(b, "a") })
    },
  },
  {
    // MinIO checks the header before authenticating (validateLengthAndChecksum), so an
    // undecodable Content-MD5 is MissingContentMD5 here, not InvalidDigest.
    name: "delete-objects-undecodable-md5",
    async run(s) {
      const b = await s.bucket("del-badmd5")
      await s.req("bad content-md5 base64", {
        method: "POST",
        path: keyPath(b),
        query: { delete: "" },
        body: deleteBody(["a"]),
        headers: { "content-md5": "!!!" },
      })
    },
  },
  {
    name: "delete-objects-1000",
    async run(s) {
      const b = await s.bucket("del-thousand")
      const keys = Array.from({ length: 1000 }, (_, i) => `k${String(i).padStart(4, "0")}`)
      await put(s, b, keys[0] as string)
      await put(s, b, keys[999] as string)
      await multiDelete(s, "1000 quiet", b, deleteBody(keys, true))
      await s.req("gone", { method: "HEAD", path: keyPath(b, keys[999] as string) })
    },
  },
  {
    name: "delete-objects-keys",
    async run(s) {
      const b = await s.bucket("del-keys")
      const keys = ["a&b", "<tag>", `q"uote'`, "ünï/cødé", "sp ace", "tab\tkey", "dir/"]
      for (const key of keys) await put(s, b, key, "x")
      await put(s, b, "lead")
      await multiDelete(s, "special keys", b, deleteBody([...keys, "/lead"]))
      await s.req("list after", { method: "GET", path: keyPath(b), query: { "list-type": "2" } })
      await put(s, b, "dup")
      await multiDelete(s, "duplicates", b, deleteBody(["dup", "dup", "x", "dup"]))
      await multiDelete(s, "empty key", b, deleteBody([""]))
      // One invalid name per request: MinIO files such errors under entry 0 in map order.
      await multiDelete(s, "dot dot segment", b, deleteBody(["keep", "../etc"]))
      await multiDelete(s, "dot segment", b, deleteBody(["a/./b"]))
      await multiDelete(s, "double slash", b, deleteBody(["x", "a//b", "y"]))
      await multiDelete(s, "leading slash dir", b, deleteBody(["/p/q/../r/"]))
      const raw = `<Delete><Object><Key>k1</Key><Key>k2</Key></Object><Object><VersionId>null</VersionId></Object><Object><Key> pad </Key></Object></Delete>`
      await multiDelete(s, "odd objects", b, raw)
      const cdata = `<Delete><Object><Key><![CDATA[c&d]]></Key></Object><!-- comment --><Object><Key>e&amp;f</Key></Object></Delete>`
      await multiDelete(s, "cdata and comments", b, cdata)
    },
  },
  {
    name: "delete-objects-versioned",
    async run(s) {
      const b = await s.bucket("del-mver", { versioning: "Enabled" })
      const v1 = versionOf(await put(s, b, "k", "one"))
      const v2 = versionOf(await put(s, b, "k", "two"))
      await put(s, b, "other", "x")
      await multiDelete(s, "markers", b, deleteBody(["other", "never"]))
      await multiDelete(s, "marker on marker", b, deleteBody(["other"]))
      await multiDelete(
        s,
        "by version",
        b,
        deleteBody([
          { key: "k", versionId: v2 },
          { key: "k", versionId: ABSENT_VERSION },
          { key: "k", versionId: "null" },
          { key: "k", versionId: "bogus" },
          { key: "k", versionId: "" },
        ]),
      )
      await s.req("list versions", { method: "GET", path: keyPath(b), query: { versions: "" } })
      const markers = await s.raw({ method: "GET", path: keyPath(b), query: { versions: "" } })
      const markerIds = [
        ...markers.text.matchAll(
          /<DeleteMarker><Key>([^<]*)<\/Key>.*?<VersionId>([^<]*)<\/VersionId><\/DeleteMarker>/g,
        ),
      ].map((m) => ({ key: m[1] as string, versionId: m[2] as string }))
      await multiDelete(s, "remove markers", b, deleteBody(markerIds))
      await multiDelete(
        s,
        "remove markers quiet",
        b,
        deleteBody([{ key: "k", versionId: v1 }], true),
      )
      await s.req("list versions after", {
        method: "GET",
        path: keyPath(b),
        query: { versions: "" },
      })
    },
  },
  {
    name: "delete-objects-suspended",
    async run(s) {
      const b = await s.bucket("del-msusp", { versioning: "Enabled" })
      await put(s, b, "k", "one")
      await s.raw({
        method: "PUT",
        path: keyPath(b),
        query: { versioning: "" },
        body: `<VersioningConfiguration xmlns="${XMLNS}"><Status>Suspended</Status></VersioningConfiguration>`,
      })
      await put(s, b, "n", "null")
      await multiDelete(s, "suspended markers", b, deleteBody(["k", "n", "never"]))
      await multiDelete(s, "null marker by id", b, deleteBody([{ key: "n", versionId: "null" }]))
      await s.req("list versions", { method: "GET", path: keyPath(b), query: { versions: "" } })
    },
  },
]

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()
const crc32b64 = (body: string) => {
  let crc = 0xffffffff
  for (const byte of new TextEncoder().encode(body))
    crc = (CRC_TABLE[(crc ^ byte) & 0xff] as number) ^ (crc >>> 8)
  crc = (crc ^ 0xffffffff) >>> 0
  return Buffer.from([crc >>> 24, (crc >>> 16) & 0xff, (crc >>> 8) & 0xff, crc & 0xff]).toString(
    "base64",
  )
}
