import { request } from "node:http"
import { GetObjectCommand, HeadObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3"
import { prepare } from "../client.js"
import { keyPath, type Scenario } from "../harness.js"

const bytes = (text: string) => new TextEncoder().encode(text)

export const scenarios: Scenario[] = [
  {
    name: "put-default-content-type",
    async run(s) {
      const b = await s.bucket("obj")
      await s.req("put no content-type", {
        method: "PUT",
        path: keyPath(b, "k"),
        body: bytes("data"),
      })
      await s.req("get", { method: "GET", path: keyPath(b, "k") })
      await s.req("head", { method: "HEAD", path: keyPath(b, "k") })
    },
  },
  {
    name: "put-system-headers",
    async run(s) {
      const b = await s.bucket("obj")
      await s.req("put", {
        method: "PUT",
        path: keyPath(b, "doc.html"),
        body: Bun.gzipSync(bytes("<p>hi</p>")),
        headers: {
          "content-type": "text/html; charset=utf-8",
          "content-encoding": "gzip",
          "content-disposition": 'attachment; filename="doc.html"',
          "content-language": "en-US",
          "cache-control": "max-age=3600, public",
          expires: "Thu, 01 Jan 2099 00:00:00 GMT",
          "x-amz-website-redirect-location": "/other.html",
        },
      })
      await s.req("get", { method: "GET", path: keyPath(b, "doc.html") })
      await s.req("head", { method: "HEAD", path: keyPath(b, "doc.html") })
    },
  },
  {
    name: "put-expires-unparseable",
    async run(s) {
      const b = await s.bucket("obj")
      await s.req("put", {
        method: "PUT",
        path: keyPath(b, "k"),
        body: bytes("x"),
        headers: { expires: "not a date" },
      })
      await s.req("head", { method: "HEAD", path: keyPath(b, "k") })
      await s.req("put iso expires", {
        method: "PUT",
        path: keyPath(b, "k2"),
        body: bytes("x"),
        headers: { expires: "2099-01-01T00:00:00Z" },
      })
      await s.req("head iso", { method: "HEAD", path: keyPath(b, "k2") })
    },
  },
  {
    name: "put-storage-class",
    async run(s) {
      const b = await s.bucket("obj")
      await s.req("standard", {
        method: "PUT",
        path: keyPath(b, "std"),
        body: bytes("x"),
        headers: { "x-amz-storage-class": "STANDARD" },
      })
      await s.req("head standard", { method: "HEAD", path: keyPath(b, "std") })
      await s.req("rrs", {
        method: "PUT",
        path: keyPath(b, "rrs"),
        body: bytes("x"),
        headers: { "x-amz-storage-class": "REDUCED_REDUNDANCY" },
      })
      await s.req("head rrs", { method: "HEAD", path: keyPath(b, "rrs") })
      await s.req("glacier", {
        method: "PUT",
        path: keyPath(b, "gl"),
        body: bytes("x"),
        headers: { "x-amz-storage-class": "GLACIER" },
      })
      await s.req("lowercase", {
        method: "PUT",
        path: keyPath(b, "lc"),
        body: bytes("x"),
        headers: { "x-amz-storage-class": "standard" },
      })
      await s.req("head glacier missing", { method: "HEAD", path: keyPath(b, "gl") })
    },
  },
  {
    name: "put-tagging-header",
    async run(s) {
      const b = await s.bucket("obj")
      await s.req("put tagged", {
        method: "PUT",
        path: keyPath(b, "t"),
        body: bytes("x"),
        headers: { "x-amz-tagging": "a=1&b=two" },
      })
      await s.req("get", { method: "GET", path: keyPath(b, "t") })
      await s.req("head", { method: "HEAD", path: keyPath(b, "t") })
      await s.req("get tagging", { method: "GET", path: keyPath(b, "t"), query: { tagging: "" } })
      await s.req("put one tag", {
        method: "PUT",
        path: keyPath(b, "t1"),
        body: bytes("x"),
        headers: { "x-amz-tagging": "only=" },
      })
      await s.req("head one", { method: "HEAD", path: keyPath(b, "t1") })
      await s.req("put bad tags", {
        method: "PUT",
        path: keyPath(b, "bad"),
        body: bytes("x"),
        headers: { "x-amz-tagging": "a=1&a=2" },
      })
      await s.req("put bad tag key", {
        method: "PUT",
        path: keyPath(b, "bad2"),
        body: bytes("x"),
        headers: { "x-amz-tagging": `${"k".repeat(129)}=v` },
      })
      await s.req("put bad tag value", {
        method: "PUT",
        path: keyPath(b, "bad3"),
        body: bytes("x"),
        headers: { "x-amz-tagging": `k=${"v".repeat(257)}` },
      })
      const eleven = Array.from({ length: 11 }, (_, i) => `k${i}=v`).join("&")
      await s.req("put too many tags", {
        method: "PUT",
        path: keyPath(b, "bad4"),
        body: bytes("x"),
        headers: { "x-amz-tagging": eleven },
      })
      await s.req("put encoded tags", {
        method: "PUT",
        path: keyPath(b, "enc"),
        body: bytes("x"),
        headers: { "x-amz-tagging": "a%20b=c%2Fd" },
      })
      await s.req("get encoded tagging", {
        method: "GET",
        path: keyPath(b, "enc"),
        query: { tagging: "" },
      })
      await s.req("put empty tagging", {
        method: "PUT",
        path: keyPath(b, "empty"),
        body: bytes("x"),
        headers: { "x-amz-tagging": "" },
      })
      await s.req("head empty", { method: "HEAD", path: keyPath(b, "empty") })
    },
  },
  {
    name: "put-user-metadata",
    async run(s) {
      const b = await s.bucket("obj")
      await s.req("put", {
        method: "PUT",
        path: keyPath(b, "m"),
        body: bytes("x"),
        headers: {
          "x-amz-meta-Color": "Blue",
          "x-amz-meta-UPPER-case": "MiXeD Value",
          "x-amz-meta-empty": "",
          "x-amz-meta-spaces": "  padded  ",
          "x-amz-meta-punct": "a,b;c=d\"e'f",
          "x-minio-meta-extra": "minio",
          "x-amz-meta-tab": "a\tb",
        },
      })
      await s.req("get", { method: "GET", path: keyPath(b, "m") })
      await s.req("head", { method: "HEAD", path: keyPath(b, "m") })
    },
  },
  {
    name: "put-user-metadata-size-limit",
    async run(s) {
      const b = await s.bucket("obj")
      // MinIO counts len(name) + len(value) per header against 2 KiB of user metadata.
      await s.req("at limit", {
        method: "PUT",
        path: keyPath(b, "ok"),
        body: bytes("x"),
        headers: { "x-amz-meta-a": "v".repeat(2048 - "x-amz-meta-a".length) },
      })
      await s.req("over limit", {
        method: "PUT",
        path: keyPath(b, "big"),
        body: bytes("x"),
        headers: { "x-amz-meta-a": "v".repeat(2049 - "x-amz-meta-a".length) },
      })
      await s.req("split over limit", {
        method: "PUT",
        path: keyPath(b, "big2"),
        body: bytes("x"),
        headers: { "x-amz-meta-a": "v".repeat(1000), "x-amz-meta-b": "v".repeat(1100) },
      })
      await s.req("head over limit", { method: "HEAD", path: keyPath(b, "big") })
    },
  },
  {
    name: "put-reserved-metadata",
    async run(s) {
      const b = await s.bucket("obj")
      await s.req("internal header", {
        method: "PUT",
        path: keyPath(b, "r"),
        body: bytes("x"),
        headers: { "x-minio-internal-foo": "bar" },
      })
    },
  },
  {
    name: "put-empty-object",
    async run(s) {
      const b = await s.bucket("obj")
      await s.req("put empty", { method: "PUT", path: keyPath(b, "empty"), body: new Uint8Array() })
      await s.req("get", { method: "GET", path: keyPath(b, "empty") })
      await s.req("head", { method: "HEAD", path: keyPath(b, "empty") })
      await s.req("put no body", { method: "PUT", path: keyPath(b, "nobody") })
      await s.req("get no body", { method: "GET", path: keyPath(b, "nobody") })
    },
  },
  {
    name: "put-overwrite",
    async run(s) {
      const b = await s.bucket("obj")
      await s.req("first", {
        method: "PUT",
        path: keyPath(b, "k"),
        body: bytes("one"),
        headers: { "x-amz-meta-a": "1", "content-type": "text/plain" },
      })
      await s.req("second", {
        method: "PUT",
        path: keyPath(b, "k"),
        body: bytes("second"),
        headers: { "x-amz-meta-b": "2" },
      })
      await s.req("get", { method: "GET", path: keyPath(b, "k") })
    },
  },
  {
    name: "keys-special-characters",
    async run(s) {
      const b = await s.bucket("obj")
      const keys = [
        "spaces in name.txt",
        "plus+sign",
        "percent%25literal",
        "percent%",
        "dir/",
        "a/b/c/d.txt",
        "üñíçødé/日本語.txt",
        "emoji-🎉",
        "tilde~and*star(paren)'quote'",
        "semi;colon,comma=eq&amp",
        "hash#frag?query",
        "brackets[]{}|^`",
        "  leading-spaces",
        "trailing-dot.",
        "double//slash",
      ]
      for (const key of keys) {
        await s.req(`put ${key}`, { method: "PUT", path: keyPath(b, key), body: bytes(key) })
        await s.req(`get ${key}`, { method: "GET", path: keyPath(b, key) })
        await s.req(`head ${key}`, { method: "HEAD", path: keyPath(b, key) })
      }
      await s.req("list", {
        method: "GET",
        path: keyPath(b),
        query: { "list-type": "2", "encoding-type": "url" },
      })
    },
  },
  {
    name: "keys-length",
    async run(s) {
      const b = await s.bucket("obj")
      await s.req("1024 bytes", {
        method: "PUT",
        path: keyPath(b, "k".repeat(1024)),
        body: bytes("x"),
      })
      await s.req("head 1024", { method: "HEAD", path: keyPath(b, "k".repeat(1024)) })
      await s.req("1025 bytes", {
        method: "PUT",
        path: keyPath(b, "k".repeat(1025)),
        body: bytes("x"),
      })
      await s.req("get 1025", { method: "GET", path: keyPath(b, "k".repeat(1025)) })
      await s.req("head 1025", { method: "HEAD", path: keyPath(b, "k".repeat(1025)) })
      await s.req("segment 256", {
        method: "PUT",
        path: keyPath(b, `${"s".repeat(256)}/x`),
        body: bytes("x"),
      })
      await s.req("segment 255", {
        method: "PUT",
        path: keyPath(b, `${"s".repeat(255)}/x`),
        body: bytes("x"),
      })
      await s.req("multibyte 1024", {
        method: "PUT",
        path: keyPath(b, "é".repeat(512)),
        body: bytes("x"),
      })
      await s.req("multibyte 1026", {
        method: "PUT",
        path: keyPath(b, "é".repeat(513)),
        body: bytes("x"),
      })
    },
  },
  {
    name: "keys-invalid",
    async run(s) {
      const b = await s.bucket("obj")
      await s.req("backslash", { method: "PUT", path: `${keyPath(b)}/a%5Cb`, body: bytes("x") })
      await s.req("nul byte", { method: "PUT", path: `${keyPath(b)}/a%00b`, body: bytes("x") })
      await s.req("get nul byte", { method: "GET", path: `${keyPath(b)}/a%00b` })
    },
  },
  {
    name: "put-missing-content-length",
    async run(s) {
      const b = await s.bucket("obj")
      // fetch always sends a length; a chunked body without one needs node:http.
      const { url, init } = prepare(s.target, {
        method: "PUT",
        path: keyPath(b, "k"),
        auth: "unsigned-payload",
      })
      const result = await new Promise<{ status: number; code: string }>((resolve, reject) => {
        const outgoing = request(
          url,
          { method: "PUT", headers: init.headers as Record<string, string> },
          (res) => {
            let text = ""
            res.on("data", (chunk) => (text += chunk))
            res.on("end", () =>
              resolve({ status: res.statusCode ?? 0, code: /<Code>([^<]*)/.exec(text)?.[1] ?? "" }),
            )
          },
        )
        outgoing.on("error", reject)
        outgoing.setHeader("transfer-encoding", "chunked")
        outgoing.write("chunked body")
        outgoing.end()
      })
      s.record("chunked put without content-length", result)
      await s.req("nothing stored", { method: "HEAD", path: keyPath(b, "k") })
    },
  },
  {
    name: "put-missing-bucket",
    async run(s) {
      const missing = s.name("absent")
      await s.req("put", { method: "PUT", path: keyPath(missing, "k"), body: bytes("x") })
      await s.req("get", { method: "GET", path: keyPath(missing, "k") })
      await s.req("head", { method: "HEAD", path: keyPath(missing, "k") })
    },
  },
  {
    name: "get-missing-key",
    async run(s) {
      const b = await s.bucket("obj")
      await s.req("get", { method: "GET", path: keyPath(b, "nope/key.txt") })
      await s.req("head", { method: "HEAD", path: keyPath(b, "nope/key.txt") })
      await s.req("get prefix-like", { method: "GET", path: keyPath(b, "nope/") })
    },
  },
  {
    name: "put-with-copy-source-header-invalid",
    async run(s) {
      const b = await s.bucket("obj")
      await s.req("copy source without slash", {
        method: "PUT",
        path: keyPath(b, "k"),
        body: bytes("x"),
        headers: { "x-amz-copy-source": "noslash" },
      })
    },
  },
  {
    name: "put-content-md5",
    async run(s) {
      const b = await s.bucket("obj")
      // md5("hello") = XUFAKrxLKna5cZ2REBfFkg==
      await s.req("good md5", {
        method: "PUT",
        path: keyPath(b, "k"),
        body: bytes("hello"),
        headers: { "content-md5": "XUFAKrxLKna5cZ2REBfFkg==" },
      })
      await s.req("wrong md5", {
        method: "PUT",
        path: keyPath(b, "k"),
        body: bytes("hello!"),
        headers: { "content-md5": "XUFAKrxLKna5cZ2REBfFkg==" },
      })
      await s.req("malformed md5", {
        method: "PUT",
        path: keyPath(b, "k"),
        body: bytes("hello"),
        headers: { "content-md5": "not-base64!" },
      })
      await s.req("short md5", {
        method: "PUT",
        path: keyPath(b, "k"),
        body: bytes("hello"),
        headers: { "content-md5": "AAAA" },
      })
      await s.req("empty md5", {
        method: "PUT",
        path: keyPath(b, "k"),
        body: bytes("hello"),
        headers: { "content-md5": "" },
      })
      await s.req("get", { method: "GET", path: keyPath(b, "k") })
    },
  },
  {
    name: "put-query-metadata",
    async run(s) {
      const b = await s.bucket("obj")
      // MinIO's extractMetadataFromReq reads the query string as well as the headers.
      await s.req("put with metadata in query", {
        method: "PUT",
        path: keyPath(b, "q"),
        query: { "x-amz-meta-fromquery": "yes", "content-type": "text/csv" },
        body: bytes("x"),
      })
      await s.req("head", { method: "HEAD", path: keyPath(b, "q") })
    },
  },
  {
    name: "put-content-encoding-aws-chunked",
    async run(s) {
      const b = await s.bucket("obj")
      await s.req("streaming plain", {
        method: "PUT",
        path: keyPath(b, "c1"),
        auth: "streaming",
        body: bytes("hello world"),
        chunkSize: 4,
      })
      await s.req("head plain", { method: "HEAD", path: keyPath(b, "c1") })
      await s.req("streaming gzip", {
        method: "PUT",
        path: keyPath(b, "c2"),
        auth: "streaming",
        body: Bun.gzipSync(bytes("hello world")),
        headers: { "content-encoding": "gzip" },
      })
      await s.req("head gzip", { method: "HEAD", path: keyPath(b, "c2") })
      await s.req("get gzip", { method: "GET", path: keyPath(b, "c2") })
    },
  },
  {
    name: "versioned-put-get",
    async run(s) {
      const b = await s.bucket("obj", { versioning: "Enabled" })
      const one = await s.req("put v1", {
        method: "PUT",
        path: keyPath(b, "k"),
        body: bytes("one"),
      })
      await s.req("put v2", { method: "PUT", path: keyPath(b, "k"), body: bytes("two") })
      const v1 = one.headers.get("x-amz-version-id") ?? ""
      await s.req("get latest", { method: "GET", path: keyPath(b, "k") })
      await s.req("get v1", { method: "GET", path: keyPath(b, "k"), query: { versionId: v1 } })
      await s.req("head v1", { method: "HEAD", path: keyPath(b, "k"), query: { versionId: v1 } })
      await s.req("get null version", {
        method: "GET",
        path: keyPath(b, "k"),
        query: { versionId: "null" },
      })
      await s.req("get unknown uuid", {
        method: "GET",
        path: keyPath(b, "k"),
        query: { versionId: "00000000-0000-0000-0000-000000000000" },
      })
      await s.req("head unknown uuid", {
        method: "HEAD",
        path: keyPath(b, "k"),
        query: { versionId: "00000000-0000-0000-0000-000000000000" },
      })
      const deleted = await s.req("delete latest", { method: "DELETE", path: keyPath(b, "k") })
      await s.req("get after delete marker", { method: "GET", path: keyPath(b, "k") })
      await s.req("head after delete marker", { method: "HEAD", path: keyPath(b, "k") })
      const markerId = deleted.headers.get("x-amz-version-id") ?? ""
      await s.req("get delete marker by id", {
        method: "GET",
        path: keyPath(b, "k"),
        query: { versionId: markerId },
      })
      await s.req("head delete marker by id", {
        method: "HEAD",
        path: keyPath(b, "k"),
        query: { versionId: markerId },
      })
      await s.req("get v1 still", {
        method: "GET",
        path: keyPath(b, "k"),
        query: { versionId: v1 },
      })
    },
  },
  {
    name: "version-id-validation",
    async run(s) {
      const b = await s.bucket("obj")
      await s.raw({ method: "PUT", path: keyPath(b, "k"), body: bytes("x") })
      await s.req("get invalid", {
        method: "GET",
        path: keyPath(b, "k"),
        query: { versionId: "not-a-uuid" },
      })
      await s.req("head invalid", {
        method: "HEAD",
        path: keyPath(b, "k"),
        query: { versionId: "not-a-uuid" },
      })
      await s.req("get null", {
        method: "GET",
        path: keyPath(b, "k"),
        query: { versionId: "null" },
      })
      await s.req("head null", {
        method: "HEAD",
        path: keyPath(b, "k"),
        query: { versionId: "null" },
      })
      await s.req("get empty", { method: "GET", path: keyPath(b, "k"), query: { versionId: "" } })
      await s.req("get spaces null", {
        method: "GET",
        path: keyPath(b, "k"),
        query: { versionId: " null " },
      })
      await s.req("get uppercase uuid", {
        method: "GET",
        path: keyPath(b, "k"),
        query: { versionId: "6BA7B810-9DAD-11D1-80B4-00C04FD430C8" },
      })
      await s.req("get braced uuid", {
        method: "GET",
        path: keyPath(b, "k"),
        query: { versionId: "{6ba7b810-9dad-11d1-80b4-00c04fd430c8}" },
      })
      await s.req("get urn uuid", {
        method: "GET",
        path: keyPath(b, "k"),
        query: { versionId: "urn:uuid:6ba7b810-9dad-11d1-80b4-00c04fd430c8" },
      })
      await s.req("get hex uuid", {
        method: "GET",
        path: keyPath(b, "k"),
        query: { versionId: "6ba7b8109dad11d180b400c04fd430c8" },
      })
      await s.req("missing key invalid version", {
        method: "GET",
        path: keyPath(b, "nope"),
        query: { versionId: "bad" },
      })
      await s.req("missing key uuid version", {
        method: "GET",
        path: keyPath(b, "nope"),
        query: { versionId: "6ba7b810-9dad-11d1-80b4-00c04fd430c8" },
      })
    },
  },
  {
    name: "response-overrides",
    async run(s) {
      const b = await s.bucket("obj")
      await s.raw({
        method: "PUT",
        path: keyPath(b, "a.txt"),
        body: bytes("abcdef"),
        headers: { "content-type": "text/plain", "cache-control": "max-age=60" },
      })
      const query = {
        "response-content-type": "application/json",
        "response-content-disposition": 'attachment; filename="a.json"',
        "response-cache-control": "no-store",
        "response-content-encoding": "identity",
        "response-content-language": "fr",
        "response-expires": "Thu, 01 Jan 2099 00:00:00 GMT",
      }
      await s.req("get signed", { method: "GET", path: keyPath(b, "a.txt"), query })
      await s.req("head signed", { method: "HEAD", path: keyPath(b, "a.txt"), query })
      await s.req("get presigned", {
        method: "GET",
        path: keyPath(b, "a.txt"),
        query,
        auth: "presign",
      })
      await s.req("ranged with override", {
        method: "GET",
        path: keyPath(b, "a.txt"),
        query: { "response-content-type": "text/csv" },
        headers: { range: "bytes=1-2" },
      })
      await s.req("anonymous override", {
        method: "GET",
        path: keyPath(b, "a.txt"),
        query: { "response-content-type": "text/csv" },
        auth: "anonymous",
      })
      await s.req("unknown response param", {
        method: "GET",
        path: keyPath(b, "a.txt"),
        query: { "response-x-foo": "bar" },
      })
      await s.req("empty override", {
        method: "GET",
        path: keyPath(b, "a.txt"),
        query: { "response-content-type": "" },
      })
      await s.req("uppercase param", {
        method: "GET",
        path: keyPath(b, "a.txt"),
        query: { "Response-Content-Type": "text/csv" },
      })
      await s.req("override on missing", {
        method: "GET",
        path: keyPath(b, "nope"),
        query: { "response-content-type": "text/csv" },
      })
      await s.req("override with 304", {
        method: "GET",
        path: keyPath(b, "a.txt"),
        query: { "response-content-type": "text/csv" },
        headers: { "if-none-match": "*" },
      })
    },
  },
  {
    name: "anonymous-access",
    async run(s) {
      const b = await s.bucket("obj")
      await s.raw({ method: "PUT", path: keyPath(b, "k"), body: bytes("x") })
      await s.req("anonymous get", { method: "GET", path: keyPath(b, "k"), auth: "anonymous" })
      await s.req("anonymous head", { method: "HEAD", path: keyPath(b, "k"), auth: "anonymous" })
      await s.req("anonymous put", {
        method: "PUT",
        path: keyPath(b, "k2"),
        auth: "anonymous",
        body: bytes("x"),
      })
      await s.req("anonymous get missing", {
        method: "GET",
        path: keyPath(b, "nope"),
        auth: "anonymous",
      })
    },
  },
  {
    name: "sse-on-get-rejected",
    async run(s) {
      const b = await s.bucket("obj")
      await s.raw({ method: "PUT", path: keyPath(b, "k"), body: bytes("x") })
      await s.req("get with sse header", {
        method: "GET",
        path: keyPath(b, "k"),
        headers: { "x-amz-server-side-encryption": "AES256" },
      })
      await s.req("head with sse header", {
        method: "HEAD",
        path: keyPath(b, "k"),
        headers: { "x-amz-server-side-encryption": "AES256" },
      })
    },
  },
  {
    name: "part-number-single-part",
    async run(s) {
      const b = await s.bucket("obj")
      await s.raw({ method: "PUT", path: keyPath(b, "k"), body: bytes("0123456789") })
      await s.req("get part 1", {
        method: "GET",
        path: keyPath(b, "k"),
        query: { partNumber: "1" },
      })
      await s.req("head part 1", {
        method: "HEAD",
        path: keyPath(b, "k"),
        query: { partNumber: "1" },
      })
      await s.req("get part 2", {
        method: "GET",
        path: keyPath(b, "k"),
        query: { partNumber: "2" },
      })
      await s.req("head part 2", {
        method: "HEAD",
        path: keyPath(b, "k"),
        query: { partNumber: "2" },
      })
      await s.req("get part 0", {
        method: "GET",
        path: keyPath(b, "k"),
        query: { partNumber: "0" },
      })
      await s.req("head part 0", {
        method: "HEAD",
        path: keyPath(b, "k"),
        query: { partNumber: "0" },
      })
      await s.req("get part -1", {
        method: "GET",
        path: keyPath(b, "k"),
        query: { partNumber: "-1" },
      })
      await s.req("get part abc", {
        method: "GET",
        path: keyPath(b, "k"),
        query: { partNumber: "abc" },
      })
      await s.req("head part abc", {
        method: "HEAD",
        path: keyPath(b, "k"),
        query: { partNumber: "abc" },
      })
      await s.req("get part 10000", {
        method: "GET",
        path: keyPath(b, "k"),
        query: { partNumber: "10000" },
      })
      await s.req("get part 10001", {
        method: "GET",
        path: keyPath(b, "k"),
        query: { partNumber: "10001" },
      })
      await s.req("get part empty", {
        method: "GET",
        path: keyPath(b, "k"),
        query: { partNumber: "" },
      })
      await s.req("get part with range", {
        method: "GET",
        path: keyPath(b, "k"),
        query: { partNumber: "1" },
        headers: { range: "bytes=0-1" },
      })
      await s.req("head part with range", {
        method: "HEAD",
        path: keyPath(b, "k"),
        query: { partNumber: "1" },
        headers: { range: "bytes=0-1" },
      })
      await s.req("get part 1 checksum mode", {
        method: "GET",
        path: keyPath(b, "k"),
        query: { partNumber: "1" },
        headers: { "x-amz-checksum-mode": "ENABLED" },
      })
      await s.req("get part missing key", {
        method: "GET",
        path: keyPath(b, "nope"),
        query: { partNumber: "1" },
      })
      await s.req("get part 2 missing key", {
        method: "GET",
        path: keyPath(b, "nope"),
        query: { partNumber: "2" },
      })
    },
  },
  {
    name: "part-number-empty-object",
    async run(s) {
      const b = await s.bucket("obj")
      await s.raw({ method: "PUT", path: keyPath(b, "e"), body: new Uint8Array() })
      await s.req("get part 1", {
        method: "GET",
        path: keyPath(b, "e"),
        query: { partNumber: "1" },
      })
      await s.req("head part 1", {
        method: "HEAD",
        path: keyPath(b, "e"),
        query: { partNumber: "1" },
      })
    },
  },
  {
    name: "sdk-put-get-head",
    async run(s) {
      const b = await s.bucket("obj")
      const client = s.sdk()
      const put = await client.send(
        new PutObjectCommand({
          Bucket: b,
          Key: "sdk/file.txt",
          Body: "sdk body",
          ContentType: "text/plain",
          Metadata: { Owner: "me" },
          CacheControl: "no-cache",
          Tagging: "x=1",
        }),
      )
      s.record("put", put)
      const got = await client.send(new GetObjectCommand({ Bucket: b, Key: "sdk/file.txt" }))
      const { Body, ...rest } = got
      s.record("get", rest)
      s.record("get body", await Body?.transformToString())
      s.record("head", await client.send(new HeadObjectCommand({ Bucket: b, Key: "sdk/file.txt" })))
      s.record(
        "head checksum mode",
        await client.send(
          new HeadObjectCommand({ Bucket: b, Key: "sdk/file.txt", ChecksumMode: "ENABLED" }),
        ),
      )
      const ranged = await client.send(
        new GetObjectCommand({ Bucket: b, Key: "sdk/file.txt", Range: "bytes=0-2" }),
      )
      const { Body: rangedBody, ...rangedRest } = ranged
      s.record("ranged", rangedRest)
      s.record("ranged body", await rangedBody?.transformToString())
      s.record(
        "missing",
        await s.errorName(() => client.send(new GetObjectCommand({ Bucket: b, Key: "nope" }))),
      )
      s.record(
        "head missing",
        await s.errorName(() => client.send(new HeadObjectCommand({ Bucket: b, Key: "nope" }))),
      )
      s.record(
        "if-none-match 304",
        await s.errorName(() =>
          client.send(new GetObjectCommand({ Bucket: b, Key: "sdk/file.txt", IfNoneMatch: "*" })),
        ),
      )
    },
  },
  {
    name: "sdk-put-binary",
    async run(s) {
      const b = await s.bucket("obj")
      const client = s.sdk()
      const body = new Uint8Array(70_000).map((_, i) => (i * 31) % 256)
      s.record(
        "put",
        await client.send(new PutObjectCommand({ Bucket: b, Key: "bin", Body: body })),
      )
      const got = await client.send(
        new GetObjectCommand({ Bucket: b, Key: "bin", ChecksumMode: "ENABLED" }),
      )
      const { Body, ...rest } = got
      s.record("get", rest)
      s.record("bytes", (await Body?.transformToByteArray())?.length)
      await s.req("raw get", { method: "GET", path: keyPath(b, "bin") })
    },
  },
  {
    name: "tagging-directive-access",
    async run(s) {
      const b = await s.bucket("obj")
      await s.raw({
        method: "PUT",
        path: keyPath(b, "t"),
        body: bytes("x"),
        headers: { "x-amz-tagging": "b=2&a=1" },
      })
      const access = { "x-amz-tagging-directive": "ACCESS" }
      await s.req("get with access", { method: "GET", path: keyPath(b, "t"), headers: access })
      await s.req("head with access", { method: "HEAD", path: keyPath(b, "t"), headers: access })
      await s.req("head with other directive", {
        method: "HEAD",
        path: keyPath(b, "t"),
        headers: { "x-amz-tagging-directive": "COPY" },
      })
      await s.raw({ method: "PUT", path: keyPath(b, "u"), body: bytes("x") })
      await s.req("untagged with access", {
        method: "HEAD",
        path: keyPath(b, "u"),
        headers: access,
      })
    },
  },
  {
    name: "expires-normalized",
    async run(s) {
      const b = await s.bucket("obj")
      await s.raw({
        method: "PUT",
        path: keyPath(b, "a"),
        body: bytes("x"),
        headers: { expires: "Thu, 1 Jan 2099 00:00:00 GMT" },
      })
      await s.req("one-digit day", { method: "HEAD", path: keyPath(b, "a") })
      await s.raw({
        method: "PUT",
        path: keyPath(b, "b"),
        body: bytes("x"),
        headers: { expires: "thu, 01 jan 2099 00:00:00 GMT" },
      })
      await s.req("lowercase names", { method: "HEAD", path: keyPath(b, "b") })
      await s.raw({
        method: "PUT",
        path: keyPath(b, "c"),
        body: bytes("x"),
        headers: { expires: "Mon, 01 Jan 2099 00:00:00 GMT" },
      })
      await s.req("wrong weekday", { method: "HEAD", path: keyPath(b, "c") })
      await s.raw({
        method: "PUT",
        path: keyPath(b, "d"),
        body: bytes("x"),
        headers: { expires: "Thu, 01 Jan 1970 00:00:00 GMT" },
      })
      await s.req("epoch", { method: "HEAD", path: keyPath(b, "d") })
      await s.raw({
        method: "PUT",
        path: keyPath(b, "e"),
        body: bytes("x"),
        headers: { expires: "Thu, 01 Jan 2099 00:00:00.123 GMT" },
      })
      await s.req("fractional seconds", { method: "HEAD", path: keyPath(b, "e") })
      await s.raw({
        method: "PUT",
        path: keyPath(b, "f"),
        body: bytes("x"),
        headers: { expires: "Thu, 01 Jan 2099 00:00:00 UTC" },
      })
      await s.req("utc zone", { method: "HEAD", path: keyPath(b, "f") })
    },
  },
  {
    name: "content-headers-edge",
    async run(s) {
      const b = await s.bucket("obj")
      await s.req("empty content-type", {
        method: "PUT",
        path: keyPath(b, "a"),
        body: bytes("x"),
        headers: { "content-type": "" },
      })
      await s.req("head a", { method: "HEAD", path: keyPath(b, "a") })
      await s.req("multiple encodings", {
        method: "PUT",
        path: keyPath(b, "b"),
        body: bytes("x"),
        headers: { "content-encoding": "identity, x-custom" },
      })
      await s.req("head b", { method: "HEAD", path: keyPath(b, "b") })
      await s.req("aws-chunked only, not streaming", {
        method: "PUT",
        path: keyPath(b, "c"),
        body: bytes("x"),
        headers: { "content-encoding": "aws-chunked" },
      })
      await s.req("head c", { method: "HEAD", path: keyPath(b, "c") })
      await s.req("metadata name chars", {
        method: "PUT",
        path: keyPath(b, "d"),
        body: bytes("x"),
        headers: {
          "x-amz-meta-with_underscore": "1",
          "x-amz-meta-123": "2",
          "x-amz-meta-a.b": "3",
        },
      })
      await s.req("head d", { method: "HEAD", path: keyPath(b, "d") })
      await s.req("storage class in query", {
        method: "PUT",
        path: keyPath(b, "e"),
        query: { "x-amz-storage-class": "REDUCED_REDUNDANCY" },
        body: bytes("x"),
      })
      await s.req("head e", { method: "HEAD", path: keyPath(b, "e") })
    },
  },
  {
    name: "put-version-id-param",
    async run(s) {
      const b = await s.bucket("obj")
      await s.req("put with null versionId", {
        method: "PUT",
        path: keyPath(b, "a"),
        query: { versionId: "null" },
        body: bytes("x"),
      })
      await s.req("put with uuid versionId", {
        method: "PUT",
        path: keyPath(b, "a"),
        query: { versionId: "6ba7b810-9dad-11d1-80b4-00c04fd430c8" },
        body: bytes("x"),
      })
      await s.req("put with bad versionId", {
        method: "PUT",
        path: keyPath(b, "a"),
        query: { versionId: "bad" },
        body: bytes("x"),
      })
    },
  },
  {
    name: "put-precedence",
    async run(s) {
      const b = await s.bucket("obj")
      await s.raw({ method: "PUT", path: keyPath(b, "k"), body: bytes("hello") })
      const wrongCrc = "AAAAAA=="
      await s.req("412 before checksum mismatch", {
        method: "PUT",
        path: keyPath(b, "k"),
        body: bytes("x"),
        headers: { "if-none-match": "*", "x-amz-checksum-crc32": wrongCrc },
      })
      await s.req("invalid checksum before 412", {
        method: "PUT",
        path: keyPath(b, "k"),
        body: bytes("x"),
        headers: { "if-none-match": "*", "x-amz-checksum-crc32": "!!" },
      })
      await s.req("bad md5 before 412", {
        method: "PUT",
        path: keyPath(b, "k"),
        body: bytes("x"),
        headers: { "if-none-match": "*", "content-md5": "nope" },
      })
      await s.req("412 before BadDigest", {
        method: "PUT",
        path: keyPath(b, "k"),
        body: bytes("x"),
        headers: { "if-none-match": "*", "content-md5": "XUFAKrxLKna5cZ2REBfFkg==" },
      })
      await s.req("tag error before checksum error", {
        method: "PUT",
        path: keyPath(b, "k"),
        body: bytes("x"),
        headers: { "x-amz-tagging": "a=1&a=2", "x-amz-checksum-crc32": "!!" },
      })
      await s.req("invalid name before missing bucket", {
        method: "PUT",
        path: keyPath(s.name("absent"), "a//b"),
        body: bytes("x"),
      })
      await s.req("if-match on missing bucket", {
        method: "PUT",
        path: keyPath(s.name("absent"), "k"),
        body: bytes("x"),
        headers: { "if-match": "*" },
      })
      await s.req("get invalid name on missing bucket", {
        method: "GET",
        path: keyPath(s.name("absent"), "a//b"),
      })
      await s.req("get partNumber before versionId", {
        method: "GET",
        path: keyPath(b, "k"),
        query: { partNumber: "0", versionId: "bad" },
      })
      await s.req("sse before partNumber", {
        method: "GET",
        path: keyPath(b, "k"),
        query: { partNumber: "0" },
        headers: { "x-amz-server-side-encryption": "aws:kms" },
      })
    },
  },
  {
    name: "versioned-put-options",
    async run(s) {
      const b = await s.bucket("obj", { versioning: "Enabled" })
      const id = "6ba7b810-9dad-11d1-80b4-00c04fd430c8"
      await s.req("put with explicit uuid", {
        method: "PUT",
        path: keyPath(b, "a"),
        query: { versionId: id },
        body: bytes("x"),
      })
      await s.req("get explicit uuid", {
        method: "GET",
        path: keyPath(b, "a"),
        query: { versionId: id },
      })
      await s.req("directory object", { method: "PUT", path: keyPath(b, "dir/"), body: bytes("") })
      await s.req("directory object again", {
        method: "PUT",
        path: keyPath(b, "dir/"),
        body: bytes(""),
      })
      await s.req("head directory", { method: "HEAD", path: keyPath(b, "dir/") })
    },
  },
  {
    name: "suspended-put",
    async run(s) {
      const b = await s.bucket("obj", { versioning: "Suspended" })
      await s.req("put", { method: "PUT", path: keyPath(b, "a"), body: bytes("x") })
      await s.req("head", { method: "HEAD", path: keyPath(b, "a") })
      await s.req("head null", {
        method: "HEAD",
        path: keyPath(b, "a"),
        query: { versionId: "null" },
      })
    },
  },
  {
    name: "part-number-multipart",
    async run(s) {
      const b = await s.bucket("obj")
      const created = await s.raw({
        method: "POST",
        path: keyPath(b, "mp"),
        query: { uploads: "" },
        headers: { "x-amz-checksum-algorithm": "CRC32" },
      })
      const uploadId = created.tag("UploadId") ?? ""
      const first = new Uint8Array(5 * 1024 * 1024).fill(97)
      const second = bytes("tail part")
      const crc = (data: Uint8Array) => {
        let value = 0xffffffff
        for (const byte of data) {
          value ^= byte
          for (let bit = 0; bit < 8; bit++)
            value = value & 1 ? (value >>> 1) ^ 0xedb88320 : value >>> 1
        }
        const out = (value ^ 0xffffffff) >>> 0
        return btoa(
          String.fromCharCode(out >>> 24, (out >>> 16) & 0xff, (out >>> 8) & 0xff, out & 0xff),
        )
      }
      const etags: string[] = []
      for (const [index, part] of [first, second].entries()) {
        const res = await s.raw({
          method: "PUT",
          path: keyPath(b, "mp"),
          query: { partNumber: String(index + 1), uploadId },
          body: part,
          headers: { "x-amz-checksum-crc32": crc(part) },
        })
        etags.push(res.headers.get("etag") ?? "")
      }
      const parts = etags
        .map(
          (etag, index) =>
            `<Part><PartNumber>${index + 1}</PartNumber><ETag>${etag}</ETag><ChecksumCRC32>${crc(index ? second : first)}</ChecksumCRC32></Part>`,
        )
        .join("")
      await s.raw({
        method: "POST",
        path: keyPath(b, "mp"),
        query: { uploadId },
        body: `<CompleteMultipartUpload>${parts}</CompleteMultipartUpload>`,
      })
      await s.req("head", { method: "HEAD", path: keyPath(b, "mp") })
      await s.req("head checksum mode", {
        method: "HEAD",
        path: keyPath(b, "mp"),
        headers: { "x-amz-checksum-mode": "ENABLED" },
      })
      await s.req("head part 1", {
        method: "HEAD",
        path: keyPath(b, "mp"),
        query: { partNumber: "1" },
      })
      await s.req("get part 2", {
        method: "GET",
        path: keyPath(b, "mp"),
        query: { partNumber: "2" },
      })
      await s.req("head part 2 checksum mode", {
        method: "HEAD",
        path: keyPath(b, "mp"),
        query: { partNumber: "2" },
        headers: { "x-amz-checksum-mode": "ENABLED" },
      })
      await s.req("get part 3", {
        method: "GET",
        path: keyPath(b, "mp"),
        query: { partNumber: "3" },
      })
      await s.req("head part 3", {
        method: "HEAD",
        path: keyPath(b, "mp"),
        query: { partNumber: "3" },
      })
      await s.req("ranged across parts", {
        method: "GET",
        path: keyPath(b, "mp"),
        headers: { range: "bytes=5242878-5242882" },
      })
      await s.req("if-match multipart etag", {
        method: "HEAD",
        path: keyPath(b, "mp"),
        headers: { "if-match": etags[0] ?? "" },
      })
    },
  },
]
