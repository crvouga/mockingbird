/**
 * Authentication: SigV4 header and presigned auth, streaming payloads, SigV2, payload integrity
 * (`x-amz-content-sha256`, `Content-MD5`) and anonymous access, in MinIO's exact precedence.
 */
import { createHash } from "node:crypto"
import { checksums, type Wire } from "../client.js"
import { type Ctx, keyPath, type RequestSpec, type Scenario } from "../harness.js"

type WireFn = (wire: Wire) => void

const PAST = new Date("2000-01-01T00:00:00Z")
const FUTURE = new Date("2100-01-01T00:00:00Z")
const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60 * 1000)
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex")
const md5 = (value: string) => createHash("md5").update(value).digest("base64")
const WRONG_SECRET = { accessKey: "mockingbird", secretKey: "not-the-secret" }
const UNKNOWN_KEY = { accessKey: "nobody-here", secretKey: "whatever-secret" }

/** A bucket holding `k` = `hello`. */
const seeded = async (s: Ctx, base: string) => {
  const b = await s.bucket(base)
  await s.raw({
    method: "PUT",
    path: keyPath(b, "k"),
    body: "hello",
    headers: { "content-type": "text/plain" },
  })
  return b
}

/** Rewrite the Authorization header after signing. */
const authorization =
  (rewrite: (value: string) => string): WireFn =>
  (wire) => {
    wire.headers.authorization = rewrite(wire.headers.authorization ?? "")
  }

/** Run one request spec against GET, HEAD and PUT of an object (three auth code paths). */
const everyPath = async (s: Ctx, step: string, b: string, spec: Partial<RequestSpec>) => {
  await s.req(`${step}: get`, { method: "GET", path: keyPath(b, "k"), ...spec })
  await s.req(`${step}: head`, { method: "HEAD", path: keyPath(b, "k"), ...spec })
  await s.req(`${step}: put`, { method: "PUT", path: keyPath(b, "new"), body: "data", ...spec })
}

const setQuery =
  (name: string, value: string | undefined): WireFn =>
  (wire) => {
    wire.query = wire.query.filter(([key]) => key !== name)
    if (value !== undefined) wire.query.push([name, value])
  }

export const scenarios: Scenario[] = [
  {
    name: "header-signed-requests",
    async run(s) {
      const b = await seeded(s, "auth-ok")
      await s.req("put", {
        method: "PUT",
        path: keyPath(b, "a b/ü+&=.txt"),
        body: "x",
        headers: { "content-type": "text/plain" },
      })
      await s.req("get", { method: "GET", path: keyPath(b, "a b/ü+&=.txt") })
      await s.req("head", { method: "HEAD", path: keyPath(b, "k") })
      await s.req("unsigned payload put", {
        method: "PUT",
        path: keyPath(b, "u"),
        body: "unsigned",
        auth: "unsigned-payload",
        headers: { "content-type": "text/plain" },
      })
      await s.req("unsigned payload get", {
        method: "GET",
        path: keyPath(b, "u"),
        auth: "unsigned-payload",
      })
      await s.req("list with query", {
        method: "GET",
        path: keyPath(b),
        query: { "list-type": "2", prefix: "a b/", "encoding-type": "url" },
      })
      await s.req("signed content-length", {
        method: "PUT",
        path: keyPath(b, "cl"),
        body: "four",
        headers: { "content-length": "4" },
      })
      await s.req("whitespace in signed header", {
        method: "PUT",
        path: keyPath(b, "ws"),
        body: "w",
        headers: { "x-amz-meta-spaced": "  a   b  ", "content-type": "text/plain" },
      })
      await s.req("get ws", { method: "GET", path: keyPath(b, "ws") })
    },
  },
  {
    name: "wrong-secret",
    async run(s) {
      const b = await seeded(s, "auth-secret")
      await everyPath(s, "wrong secret", b, { credentials: WRONG_SECRET })
      await s.req("missing bucket", {
        method: "GET",
        path: keyPath("auth-missing-bucket-zz", "k"),
        credentials: WRONG_SECRET,
      })
      await s.req("list buckets", { method: "GET", path: "/", credentials: WRONG_SECRET })
      await s.req("tampered list objects", { method: "GET", path: keyPath(b), tamper: true })
      await s.req("tampered delete", { method: "DELETE", path: keyPath(b, "k"), tamper: true })
      await s.req("still there", { method: "GET", path: keyPath(b, "k") })
    },
  },
  {
    name: "unknown-access-key",
    async run(s) {
      const b = await seeded(s, "auth-key")
      await everyPath(s, "unknown key", b, { credentials: UNKNOWN_KEY })
      await everyPath(s, "short key", b, { credentials: { accessKey: "ab", secretKey: "x" } })
      await s.req("unknown key missing bucket", {
        method: "PUT",
        path: keyPath("auth-missing-bucket-zz", "k"),
        body: "x",
        credentials: UNKNOWN_KEY,
      })
      await s.req("unknown key list buckets", {
        method: "GET",
        path: "/",
        credentials: UNKNOWN_KEY,
      })
      await s.req("key with slash", {
        method: "GET",
        path: keyPath(b, "k"),
        credentials: { accessKey: "a/b/c", secretKey: "x" },
      })
    },
  },
  {
    name: "malformed-authorization",
    async run(s) {
      const b = await seeded(s, "auth-malformed")
      const cases: [string, (value: string) => string][] = [
        ["algorithm only", () => "AWS4-HMAC-SHA256"],
        ["two fields", (v) => v.replace(/, Signature=.*$/, "")],
        ["four fields", (v) => `${v}, Extra=1`],
        ["no credential tag", (v) => v.replace("Credential=", "Cred=")],
        ["credential no equals", (v) => v.replace("Credential=", "Credential")],
        [
          "credential too short",
          (v) => v.replace(/Credential=[^,]+/, "Credential=mockingbird/20240101/us-east-1/s3"),
        ],
        ["credential bad date", (v) => v.replace(/\/\d{8}\//, "/2024-1-1/")],
        ["credential impossible date", (v) => v.replace(/\/\d{8}\//, "/20241345/")],
        ["credential wrong service", (v) => v.replace("/s3/aws4_request", "/ec2/aws4_request")],
        ["credential wrong version", (v) => v.replace("/aws4_request", "/aws5_request")],
        ["credential trailing slash", (v) => v.replace("/aws4_request", "/aws4_request/")],
        ["no signedheaders tag", (v) => v.replace("SignedHeaders=", "Signed=")],
        ["empty signedheaders", (v) => v.replace(/SignedHeaders=[^,]+/, "SignedHeaders=")],
        ["no signature tag", (v) => v.replace("Signature=", "Sig=")],
        ["empty signature", (v) => v.replace(/Signature=[0-9a-f]+/, "Signature=")],
        [
          "uppercase signature",
          (v) =>
            v.replace(
              /Signature=([0-9a-f]+)/,
              (_, sig: string) => `Signature=${sig.toUpperCase()}`,
            ),
        ],
        ["no spaces", (v) => v.replace(/, /g, ",")],
        [
          "extra spaces",
          (v) => v.replace(/, /g, " ,  ").replace("AWS4-HMAC-SHA256 ", "AWS4-HMAC-SHA256   "),
        ],
        ["lowercase algorithm", (v) => v.replace("AWS4-HMAC-SHA256", "aws4-hmac-sha256")],
        ["algorithm suffix", (v) => v.replace("AWS4-HMAC-SHA256", "AWS4-HMAC-SHA256X")],
        ["basic", () => "Basic bW9ja2luZ2JpcmQ6c2VjcmV0"],
        ["bearer", () => "Bearer some.jwt.token"],
        ["v2 garbage", () => "AWS nocolon"],
        ["v2 too many spaces", () => "AWS a b:c"],
      ]
      for (const [step, rewrite] of cases) {
        await s.req(`${step}: get`, {
          method: "GET",
          path: keyPath(b, "k"),
          wire: authorization(rewrite),
        })
        await s.req(`${step}: put`, {
          method: "PUT",
          path: keyPath(b, "new"),
          body: "x",
          wire: authorization(rewrite),
        })
      }
      await s.req("head no credential tag", {
        method: "HEAD",
        path: keyPath(b, "k"),
        wire: authorization((v) => v.replace("Credential=", "Cred=")),
      })
      await s.req("list buckets credential bad date", {
        method: "GET",
        path: "/",
        wire: authorization((v) => v.replace(/\/\d{8}\//, "/2024-1-1/")),
      })
    },
  },
  {
    name: "region",
    async run(s) {
      const b = await seeded(s, "auth-region")
      await everyPath(s, "wrong region", b, { region: "eu-west-1" })
      await s.req("US alias", { method: "GET", path: keyPath(b, "k"), region: "US" })
      await s.req("list buckets any region", { method: "GET", path: "/", region: "eu-west-1" })
      await s.req("location any region", {
        method: "GET",
        path: keyPath(b),
        query: { location: "" },
        region: "ap-south-1",
      })
      await s.req("location wrong secret", {
        method: "GET",
        path: keyPath(b),
        query: { location: "" },
        region: "ap-south-1",
        credentials: WRONG_SECRET,
      })
      await s.req("create bucket wrong region", {
        method: "PUT",
        path: keyPath(s.name("auth-region-new")),
        region: "eu-west-1",
      })
    },
  },
  {
    name: "request-dates",
    async run(s) {
      const b = await seeded(s, "auth-dates")
      const dropDate: WireFn = (wire) => {
        delete wire.headers["x-amz-date"]
      }
      await everyPath(s, "missing x-amz-date", b, { wire: dropDate })
      await everyPath(s, "malformed x-amz-date", b, {
        wire: (wire) => {
          wire.headers["x-amz-date"] = "yesterday"
        },
      })
      await everyPath(s, "skewed past", b, { date: PAST })
      await everyPath(s, "skewed future", b, { date: FUTURE })
      await s.req("twenty minutes ago", {
        method: "GET",
        path: keyPath(b, "k"),
        date: minutesAgo(20),
      })
      await s.req("ten minutes ago", { method: "GET", path: keyPath(b, "k"), date: minutesAgo(10) })
      await s.req("skewed with wrong secret", {
        method: "GET",
        path: keyPath(b, "k"),
        date: PAST,
        credentials: WRONG_SECRET,
      })
      await s.req("skewed with unknown key", {
        method: "GET",
        path: keyPath(b, "k"),
        date: PAST,
        credentials: UNKNOWN_KEY,
      })
      await s.req("skewed on missing bucket", {
        method: "GET",
        path: keyPath("auth-missing-bucket-zz", "k"),
        date: PAST,
      })
      await s.req("skewed list buckets", { method: "GET", path: "/", date: PAST })
      await s.req("skewed invalid bucket name", { method: "GET", path: "/AB/k", date: PAST })
      await s.req("rfc1123 x-amz-date", {
        method: "GET",
        path: keyPath(b, "k"),
        wire: (wire) => {
          wire.headers["x-amz-date"] = new Date().toUTCString()
        },
      })
      await s.req("iso date header, unsigned x-amz-date", {
        method: "GET",
        path: keyPath(b, "k"),
        signedHeaders: ["host", "x-amz-content-sha256"],
        wire: (wire) => {
          wire.headers.date = wire.headers["x-amz-date"] as string
          delete wire.headers["x-amz-date"]
        },
      })
      await s.req("rfc1123 date header only", {
        method: "GET",
        path: keyPath(b, "k"),
        signedHeaders: ["host", "x-amz-content-sha256"],
        wire: (wire) => {
          wire.headers.date = new Date().toUTCString()
          delete wire.headers["x-amz-date"]
        },
      })
    },
  },
  {
    name: "signed-headers",
    async run(s) {
      const b = await seeded(s, "auth-signed")
      await everyPath(s, "host not signed", b, {
        signedHeaders: ["x-amz-content-sha256", "x-amz-date"],
      })
      await everyPath(s, "signed header absent", b, {
        signedHeaders: ["host", "x-amz-content-sha256", "x-amz-date", "x-amz-meta-absent"],
      })
      await s.req("content-type changed", {
        method: "PUT",
        path: keyPath(b, "ct"),
        body: "x",
        headers: { "content-type": "text/plain" },
        wire: (wire) => {
          wire.headers["content-type"] = "text/html"
        },
      })
      await s.req("unsigned meta header", {
        method: "PUT",
        path: keyPath(b, "meta"),
        body: "x",
        headers: { "content-type": "text/plain" },
        wire: (wire) => {
          wire.headers["x-amz-meta-sneaky"] = "yes"
        },
      })
      await s.req("get meta", { method: "GET", path: keyPath(b, "meta") })
      await s.req("only host signed", {
        method: "GET",
        path: keyPath(b, "k"),
        signedHeaders: ["host"],
      })
      await s.req("signed expect", {
        method: "GET",
        path: keyPath(b, "k"),
        signedHeaders: ["expect", "host", "x-amz-content-sha256", "x-amz-date"],
        headers: { expect: "100-continue" },
        wire: (wire) => {
          delete wire.headers.expect
        },
      })
      await s.req("uppercase signed header name", {
        method: "GET",
        path: keyPath(b, "k"),
        signedHeaders: ["host", "X-Amz-Date", "x-amz-content-sha256"],
      })
      await s.req("query changed after signing", {
        method: "GET",
        path: keyPath(b),
        query: { prefix: "a" },
        wire: setQuery("prefix", "b"),
      })
      await s.req("query added after signing", {
        method: "GET",
        path: keyPath(b, "k"),
        wire: setQuery("extra", "1"),
      })
    },
  },
  {
    name: "content-sha256",
    async run(s) {
      const b = await seeded(s, "auth-sha")
      await s.req("mismatch put", {
        method: "PUT",
        path: keyPath(b, "m"),
        body: "data",
        contentSha256: sha256("other"),
      })
      await s.req("mismatch get missing", { method: "GET", path: keyPath(b, "m") })
      await s.req("invalid hex put", {
        method: "PUT",
        path: keyPath(b, "m"),
        body: "data",
        contentSha256: "not-hex",
      })
      await s.req("invalid hex get", {
        method: "GET",
        path: keyPath(b, "k"),
        contentSha256: "not-hex",
      })
      await s.req("odd hex get", { method: "GET", path: keyPath(b, "k"), contentSha256: "abc" })
      await s.req("empty string put", {
        method: "PUT",
        path: keyPath(b, "m"),
        body: "data",
        contentSha256: "",
      })
      await s.req("uppercase hex put", {
        method: "PUT",
        path: keyPath(b, "upper"),
        body: "data",
        contentSha256: sha256("data").toUpperCase(),
        headers: { "content-type": "text/plain" },
      })
      await s.req("short valid hex put", {
        method: "PUT",
        path: keyPath(b, "short"),
        body: "data",
        contentSha256: "abcd",
      })
      await s.req("mismatch get with body hash", {
        method: "GET",
        path: keyPath(b, "k"),
        contentSha256: sha256("other"),
      })
      await s.req("empty-body hash on put", {
        method: "PUT",
        path: keyPath(b, "e"),
        body: "data",
        contentSha256: sha256(""),
      })
      await s.req("no header, empty body", {
        method: "GET",
        path: keyPath(b, "k"),
        signedHeaders: ["host", "x-amz-date"],
        wire: (wire) => {
          delete wire.headers["x-amz-content-sha256"]
        },
      })
      await s.req("no header, body", {
        method: "PUT",
        path: keyPath(b, "nh"),
        body: "data",
        signedHeaders: ["host", "x-amz-date"],
        wire: (wire) => {
          delete wire.headers["x-amz-content-sha256"]
        },
      })
      await s.req("k still there", { method: "HEAD", path: keyPath(b, "k") })
    },
  },
  {
    name: "content-md5",
    async run(s) {
      const b = await seeded(s, "auth-md5")
      await s.req("valid", {
        method: "PUT",
        path: keyPath(b, "ok"),
        body: "data",
        headers: { "content-md5": md5("data") },
      })
      await s.req("mismatch", {
        method: "PUT",
        path: keyPath(b, "bad"),
        body: "data",
        headers: { "content-md5": md5("other") },
      })
      await s.req("mismatch not stored", { method: "HEAD", path: keyPath(b, "bad") })
      await s.req("not base64", {
        method: "PUT",
        path: keyPath(b, "bad"),
        body: "data",
        headers: { "content-md5": "!!!not-base64" },
      })
      await s.req("wrong length", {
        method: "PUT",
        path: keyPath(b, "bad"),
        body: "data",
        headers: { "content-md5": "YWJj" },
      })
      await s.req("unpadded", {
        method: "PUT",
        path: keyPath(b, "bad"),
        body: "data",
        headers: { "content-md5": md5("data").replace(/=+$/, "") },
      })
      await s.req("hex instead of base64", {
        method: "PUT",
        path: keyPath(b, "bad"),
        body: "data",
        headers: { "content-md5": createHash("md5").update("data").digest("hex") },
      })
      await s.req("invalid + wrong secret put", {
        method: "PUT",
        path: keyPath(b, "bad"),
        body: "data",
        headers: { "content-md5": "YWJj" },
        credentials: WRONG_SECRET,
      })
      await s.req("mismatch + wrong secret put", {
        method: "PUT",
        path: keyPath(b, "bad"),
        body: "data",
        headers: { "content-md5": md5("other") },
        credentials: WRONG_SECRET,
      })
      await s.req("invalid + unknown key put", {
        method: "PUT",
        path: keyPath(b, "bad"),
        body: "data",
        headers: { "content-md5": "YWJj" },
        credentials: UNKNOWN_KEY,
      })
      await s.req("invalid + anonymous put", {
        method: "PUT",
        path: keyPath(b, "bad"),
        body: "data",
        headers: { "content-md5": "YWJj" },
        auth: "anonymous",
      })
      await s.req("invalid on missing bucket", {
        method: "PUT",
        path: keyPath("auth-missing-bucket-zz", "bad"),
        body: "data",
        headers: { "content-md5": "YWJj" },
      })
      await s.req("mismatch on missing bucket", {
        method: "PUT",
        path: keyPath("auth-missing-bucket-zz", "bad"),
        body: "data",
        headers: { "content-md5": md5("other") },
      })
      await s.req("invalid + wrong secret get", {
        method: "GET",
        path: keyPath(b, "k"),
        headers: { "content-md5": "YWJj" },
        credentials: WRONG_SECRET,
      })
      await s.req("invalid get", {
        method: "GET",
        path: keyPath(b, "k"),
        headers: { "content-md5": "YWJj" },
      })
      await s.req("mismatch get (body unread)", {
        method: "GET",
        path: keyPath(b, "k"),
        headers: { "content-md5": md5("other") },
      })
      await s.req("md5 + sha mismatch", {
        method: "PUT",
        path: keyPath(b, "bad"),
        body: "data",
        headers: { "content-md5": md5("other") },
        contentSha256: sha256("other"),
      })
      await s.req("md5 with unsigned payload", {
        method: "PUT",
        path: keyPath(b, "bad"),
        body: "data",
        headers: { "content-md5": md5("other") },
        auth: "unsigned-payload",
      })
      await s.req("md5 with presign", {
        method: "PUT",
        path: keyPath(b, "bad"),
        body: "data",
        headers: { "content-md5": md5("other") },
        auth: "presign",
      })
      await s.req("valid md5 with presign", {
        method: "PUT",
        path: keyPath(b, "ok2"),
        body: "data",
        headers: { "content-md5": md5("data") },
        auth: "presign",
      })
    },
  },
  {
    name: "presigned",
    async run(s) {
      const b = await seeded(s, "auth-presign")
      await s.req("get", { method: "GET", path: keyPath(b, "k"), auth: "presign" })
      await s.req("head", { method: "HEAD", path: keyPath(b, "k"), auth: "presign" })
      await s.req("put", {
        method: "PUT",
        path: keyPath(b, "p q/ü"),
        body: "presigned body",
        auth: "presign",
        headers: { "content-type": "text/plain" },
      })
      await s.req("get put", { method: "GET", path: keyPath(b, "p q/ü"), auth: "presign" })
      await s.req("list objects", {
        method: "GET",
        path: keyPath(b),
        query: { "list-type": "2" },
        auth: "presign",
      })
      await s.req("list buckets wrong region", {
        method: "GET",
        path: "/",
        auth: "presign",
        region: "eu-west-1",
      })
      await s.req("missing bucket", {
        method: "GET",
        path: keyPath("auth-missing-bucket-zz", "k"),
        auth: "presign",
      })
      await s.req("missing key", { method: "GET", path: keyPath(b, "nope"), auth: "presign" })
      await s.req("delete", { method: "DELETE", path: keyPath(b, "p q/ü"), auth: "presign" })
      await s.req("signed extra param", {
        method: "GET",
        path: keyPath(b, "k"),
        query: { foo: "bar" },
        auth: "presign",
      })
      await s.req("max expires", {
        method: "GET",
        path: keyPath(b, "k"),
        auth: "presign",
        expires: 604800,
      })
      await s.req("zero expires", {
        method: "GET",
        path: keyPath(b, "k"),
        auth: "presign",
        expires: 0,
        date: minutesAgo(1),
      })
      await s.req("one second fresh", {
        method: "GET",
        path: keyPath(b, "k"),
        auth: "presign",
        expires: 60,
      })
    },
  },
  {
    name: "presigned-errors",
    async run(s) {
      const b = await seeded(s, "auth-presign-err")
      const get = (step: string, spec: Partial<RequestSpec>) =>
        s.req(step, { method: "GET", path: keyPath(b, "k"), auth: "presign", ...spec })
      await get("expired", { date: PAST, expires: 900 })
      await get("expired put", { date: minutesAgo(20), expires: 60 })
      await s.req("expired put", {
        method: "PUT",
        path: keyPath(b, "x"),
        body: "x",
        auth: "presign",
        date: PAST,
      })
      await get("not yet valid", { date: FUTURE })
      await get("slightly future", { date: new Date(Date.now() + 5 * 60 * 1000) })
      await get("over max expires", { expires: 604801 })
      await get("negative expires", { expires: -1 })
      await get("malformed expires", { wire: setQuery("X-Amz-Expires", "abc") })
      await get("fractional expires", { wire: setQuery("X-Amz-Expires", "900.5") })
      await get("empty expires", { wire: setQuery("X-Amz-Expires", "") })
      await get("tampered", { tamper: true })
      await get("tampered put", { tamper: true, method: "PUT", body: "x" })
      await get("uppercase signature", {
        wire: (w) => {
          w.query = w.query.map(([n, v]) => [n, n === "X-Amz-Signature" ? v.toUpperCase() : v])
        },
      })
      await get("wrong algorithm", { wire: setQuery("X-Amz-Algorithm", "AWS4-HMAC-SHA1") })
      for (const name of [
        "X-Amz-Algorithm",
        "X-Amz-Credential",
        "X-Amz-Signature",
        "X-Amz-Date",
        "X-Amz-SignedHeaders",
        "X-Amz-Expires",
      ])
        await get(`missing ${name}`, { wire: setQuery(name, undefined) })
      await get("empty signature", { wire: setQuery("X-Amz-Signature", "") })
      await get("empty signed headers", { wire: setQuery("X-Amz-SignedHeaders", "") })
      await get("malformed date", { wire: setQuery("X-Amz-Date", "20240101") })
      await get("extra unsigned param", { wire: setQuery("extra", "1") })
      await get("unknown key", { credentials: UNKNOWN_KEY })
      await get("wrong secret", { credentials: WRONG_SECRET })
      await get("wrong region", { region: "eu-west-1" })
      await get("credential bad date", {
        wire: (w) => {
          w.query = w.query.map(([n, v]) => [
            n,
            n === "X-Amz-Credential" ? v.replace(/\/\d{8}\//, "/2024-1-1/") : v,
          ])
        },
      })
      await get("host not signed", { signedHeaders: ["x-amz-date"] })
      await get("unsigned meta header", { headers: { "x-amz-meta-a": "1" } })
      await get("signed meta header", {
        headers: { "x-amz-meta-a": "1" },
        signedHeaders: ["host", "x-amz-meta-a"],
      })
      await get("signed header changed", {
        headers: { "x-amz-meta-a": "1" },
        signedHeaders: ["host", "x-amz-meta-a"],
        wire: (w) => {
          w.headers["x-amz-meta-a"] = "2"
        },
      })
      await get("plus authorization header", {
        wire: (w) => {
          w.headers.authorization = "AWS4-HMAC-SHA256 Credential=x"
        },
      })
      await get("expired on missing bucket", {
        date: PAST,
        path: keyPath("auth-missing-bucket-zz", "k"),
      })
      await s.req("presigned head expired", {
        method: "HEAD",
        path: keyPath(b, "k"),
        auth: "presign",
        date: PAST,
      })
      await s.req("presigned list buckets tampered", {
        method: "GET",
        path: "/",
        auth: "presign",
        tamper: true,
      })
    },
  },
  {
    name: "presigned-content-sha256",
    async run(s) {
      const b = await seeded(s, "auth-presign-sha")
      await s.req("matching sha put", {
        method: "PUT",
        path: keyPath(b, "a"),
        body: "data",
        auth: "presign",
        query: { "X-Amz-Content-Sha256": sha256("data") },
        headers: { "content-type": "text/plain" },
      })
      await s.req("get a", { method: "GET", path: keyPath(b, "a") })
      await s.req("mismatched sha put", {
        method: "PUT",
        path: keyPath(b, "b"),
        body: "data",
        auth: "presign",
        query: { "X-Amz-Content-Sha256": sha256("other") },
      })
      await s.req("unsigned sha put", {
        method: "PUT",
        path: keyPath(b, "c"),
        body: "data",
        auth: "presign",
        query: { "X-Amz-Content-Sha256": "UNSIGNED-PAYLOAD" },
      })
      await s.req("header sha put", {
        method: "PUT",
        path: keyPath(b, "d"),
        body: "data",
        auth: "presign",
        headers: { "x-amz-content-sha256": sha256("other") },
      })
    },
  },
  {
    name: "streaming-signed",
    async run(s) {
      const b = await s.bucket("auth-stream")
      const body = "streaming payload with several chunks"
      await s.req("put", {
        method: "PUT",
        path: keyPath(b, "s"),
        body,
        auth: "streaming",
        chunkSize: 8,
        headers: { "content-type": "text/plain" },
      })
      await s.req("get", { method: "GET", path: keyPath(b, "s") })
      await s.req("single chunk", {
        method: "PUT",
        path: keyPath(b, "one"),
        body,
        auth: "streaming",
        headers: { "content-type": "text/plain" },
      })
      await s.req("get one", { method: "GET", path: keyPath(b, "one") })
      await s.req("empty", {
        method: "PUT",
        path: keyPath(b, "empty"),
        body: "",
        auth: "streaming",
        headers: { "content-type": "text/plain" },
      })
      await s.req("head empty", { method: "HEAD", path: keyPath(b, "empty") })
      await s.req("with content-md5", {
        method: "PUT",
        path: keyPath(b, "md5"),
        body,
        auth: "streaming",
        chunkSize: 10,
        headers: { "content-md5": md5(body) },
      })
      await s.req("with wrong content-md5", {
        method: "PUT",
        path: keyPath(b, "md5bad"),
        body,
        auth: "streaming",
        chunkSize: 10,
        headers: { "content-md5": md5("x") },
      })
      await s.req("missing bucket", {
        method: "PUT",
        path: keyPath("auth-missing-bucket-zz", "s"),
        body,
        auth: "streaming",
      })
    },
  },
  {
    name: "streaming-signed-errors",
    async run(s) {
      const b = await s.bucket("auth-stream-err")
      const body = "0123456789abcdefghij"
      const put = (step: string, spec: Partial<RequestSpec>) =>
        s.req(step, {
          method: "PUT",
          path: keyPath(b, "s"),
          body,
          auth: "streaming",
          chunkSize: 8,
          ...spec,
        })
      const editBody =
        (edit: (text: string) => string): WireFn =>
        (wire) => {
          wire.body = new TextEncoder().encode(edit(new TextDecoder("latin1").decode(wire.body)))
        }
      await put("tampered seed", { tamper: true })
      await put("bad first chunk signature", {
        wire: editBody((t) =>
          t.replace(
            /chunk-signature=([0-9a-f])/,
            (_, c: string) => `chunk-signature=${c === "0" ? "1" : "0"}`,
          ),
        ),
      })
      await put("bad final chunk signature", {
        wire: editBody((t) =>
          t.replace(
            /0;chunk-signature=([0-9a-f])([0-9a-f]{63})\r\n\r\n$/,
            (_, c: string, rest: string) =>
              `0;chunk-signature=${c === "0" ? "1" : "0"}${rest}\r\n\r\n`,
          ),
        ),
      })
      await put("chunk data changed", { wire: editBody((t) => t.replace("01234567", "01234568")) })
      await put("decoded length too large", { headers: { "x-amz-decoded-content-length": "30" } })
      await put("decoded length too small", { headers: { "x-amz-decoded-content-length": "10" } })
      await put("decoded length not a number", {
        headers: { "x-amz-decoded-content-length": "ten" },
      })
      await put("decoded length empty", { headers: { "x-amz-decoded-content-length": "" } })
      await put("no decoded length", {
        signedHeaders: ["content-encoding", "host", "x-amz-content-sha256", "x-amz-date"],
        wire: (w) => {
          delete w.headers["x-amz-decoded-content-length"]
        },
      })
      await put("non-hex chunk size", { wire: editBody((t) => t.replace(/^8;/, "z;")) })
      await put("missing CRLF after data", {
        wire: editBody((t) => t.replace("01234567\r\n", "01234567XX")),
      })
      await put("missing chunk-signature", {
        wire: editBody((t) => t.replace(/^8;chunk-signature=/, "8;chunk-signaturX=")),
      })
      await put("truncated", {
        wire: (w) => {
          w.body = w.body.subarray(0, 60)
        },
      })
      await put("missing final chunk", {
        wire: editBody((t) => t.replace(/0;chunk-signature=[0-9a-f]{64}\r\n\r\n$/, "")),
      })
      await put("unknown key", { credentials: UNKNOWN_KEY })
      await put("wrong region", { region: "eu-west-1" })
      await put("skewed", { date: PAST })
      await put("no authorization", {
        wire: (w) => {
          delete w.headers.authorization
        },
      })
      await s.req("nothing stored", { method: "HEAD", path: keyPath(b, "s") })
      await s.req("streaming create bucket", {
        method: "PUT",
        path: keyPath(s.name("auth-stream-new")),
        body: "",
        auth: "streaming",
      })
      await s.req("streaming tagging", {
        method: "PUT",
        path: keyPath(b, "s"),
        query: { tagging: "" },
        body: "<Tagging><TagSet></TagSet></Tagging>",
        auth: "streaming",
      })
    },
  },
  {
    name: "streaming-trailers",
    async run(s) {
      const b = await s.bucket("auth-trailer")
      const body = "trailing checksum payload"
      const bytes = new TextEncoder().encode(body)
      const good = checksums.crc32(bytes)
      await s.req("unsigned trailer ok", {
        method: "PUT",
        path: keyPath(b, "u"),
        body,
        auth: "streaming-unsigned-trailer",
        chunkSize: 10,
        trailer: ["x-amz-checksum-crc32", good],
        headers: { "content-type": "text/plain" },
      })
      await s.req("get u", { method: "GET", path: keyPath(b, "u") })
      await s.req("unsigned trailer wrong", {
        method: "PUT",
        path: keyPath(b, "w"),
        body,
        auth: "streaming-unsigned-trailer",
        trailer: ["x-amz-checksum-crc32", checksums.crc32(new TextEncoder().encode("x"))],
      })
      await s.req("unsigned trailer sha256 ok", {
        method: "PUT",
        path: keyPath(b, "sha"),
        body,
        auth: "streaming-unsigned-trailer",
        trailer: ["x-amz-checksum-sha256", checksums.sha256(bytes)],
      })
      await s.req("unsigned no trailer", {
        method: "PUT",
        path: keyPath(b, "none"),
        body,
        auth: "streaming-unsigned-trailer",
        headers: { "content-type": "text/plain" },
      })
      await s.req("get none", { method: "GET", path: keyPath(b, "none") })
      await s.req("unsigned trailer declared, absent", {
        method: "PUT",
        path: keyPath(b, "absent"),
        body,
        auth: "streaming-unsigned-trailer",
        headers: { "x-amz-trailer": "x-amz-checksum-crc32" },
      })
      await s.req("unsigned trailer undeclared", {
        method: "PUT",
        path: keyPath(b, "undeclared"),
        body,
        auth: "streaming-unsigned-trailer",
        trailer: ["x-amz-checksum-crc32", good],
        signedHeaders: [
          "content-encoding",
          "host",
          "x-amz-content-sha256",
          "x-amz-date",
          "x-amz-decoded-content-length",
        ],
        wire: (w) => {
          delete w.headers["x-amz-trailer"]
        },
      })
      await s.req("unsigned trailer wrong seed", {
        method: "PUT",
        path: keyPath(b, "t"),
        body,
        auth: "streaming-unsigned-trailer",
        trailer: ["x-amz-checksum-crc32", good],
        tamper: true,
      })
      await s.req("unsigned trailer anonymous", {
        method: "PUT",
        path: keyPath(b, "anon"),
        body,
        auth: "streaming-unsigned-trailer",
        trailer: ["x-amz-checksum-crc32", good],
        wire: (w) => {
          delete w.headers.authorization
        },
      })
      await s.req("signed trailer ok", {
        method: "PUT",
        path: keyPath(b, "st"),
        body,
        auth: "streaming-signed-trailer",
        chunkSize: 10,
        trailer: ["x-amz-checksum-crc32", good],
        headers: { "content-type": "text/plain" },
      })
      await s.req("get st", { method: "GET", path: keyPath(b, "st") })
      await s.req("signed trailer wrong checksum", {
        method: "PUT",
        path: keyPath(b, "st2"),
        body,
        auth: "streaming-signed-trailer",
        trailer: ["x-amz-checksum-crc32", checksums.crc32(new TextEncoder().encode("x"))],
      })
      await s.req("signed trailer bad signature", {
        method: "PUT",
        path: keyPath(b, "st3"),
        body,
        auth: "streaming-signed-trailer",
        trailer: ["x-amz-checksum-crc32", good],
        wire: (w) => {
          const text = new TextDecoder("latin1").decode(w.body)
          w.body = new TextEncoder().encode(
            text.replace(
              /x-amz-trailer-signature:([0-9a-f])/,
              (_, c: string) => `x-amz-trailer-signature:${c === "0" ? "1" : "0"}`,
            ),
          )
        },
      })
      await s.req("signed trailer bad chunk signature", {
        method: "PUT",
        path: keyPath(b, "st4"),
        body,
        auth: "streaming-signed-trailer",
        trailer: ["x-amz-checksum-crc32", good],
        wire: (w) => {
          const text = new TextDecoder("latin1").decode(w.body)
          w.body = new TextEncoder().encode(
            text.replace(
              /chunk-signature=([0-9a-f])/,
              (_, c: string) => `chunk-signature=${c === "0" ? "1" : "0"}`,
            ),
          )
        },
      })
      await s.req("head st2", { method: "HEAD", path: keyPath(b, "st2") })
    },
  },
  {
    name: "signature-v2",
    async run(s) {
      const b = await seeded(s, "auth-v2")
      await s.req("get", { method: "GET", path: keyPath(b, "k"), auth: "v2" })
      await s.req("head", { method: "HEAD", path: keyPath(b, "k"), auth: "v2" })
      await s.req("put", {
        method: "PUT",
        path: keyPath(b, "v2 ü"),
        body: "v2 body",
        auth: "v2",
        headers: {
          "content-type": "text/plain",
          "x-amz-meta-a": "b",
          "content-md5": md5("v2 body"),
        },
      })
      await s.req("get put", { method: "GET", path: keyPath(b, "v2 ü"), auth: "v2" })
      await s.req("list objects", {
        method: "GET",
        path: keyPath(b),
        query: { prefix: "v" },
        auth: "v2",
      })
      await s.req("location subresource", {
        method: "GET",
        path: keyPath(b),
        query: { location: "" },
        auth: "v2",
      })
      await s.req("list buckets", {
        method: "GET",
        path: "/",
        auth: "v2",
      })
      await s.req("wrong secret", {
        method: "GET",
        path: keyPath(b, "k"),
        auth: "v2",
        credentials: WRONG_SECRET,
      })
      await s.req("wrong secret put", {
        method: "PUT",
        path: keyPath(b, "x"),
        body: "x",
        auth: "v2",
        credentials: WRONG_SECRET,
      })
      await s.req("unknown key", {
        method: "GET",
        path: keyPath(b, "k"),
        auth: "v2",
        credentials: UNKNOWN_KEY,
      })
      await s.req("tampered head", {
        method: "HEAD",
        path: keyPath(b, "k"),
        auth: "v2",
        tamper: true,
      })
      await s.req("missing date", {
        method: "GET",
        path: keyPath(b, "k"),
        auth: "v2",
        wire: (w) => {
          delete w.headers.date
        },
      })
      await s.req("skewed date", { method: "GET", path: keyPath(b, "k"), auth: "v2", date: PAST })
      await s.req("x-amz-date", {
        method: "GET",
        path: keyPath(b, "k"),
        auth: "v2",
        headers: { "x-amz-date": new Date().toUTCString(), date: "" },
        wire: (w) => {
          delete w.headers.date
        },
      })
      await s.req("unsigned subresource", {
        method: "GET",
        path: keyPath(b),
        auth: "v2",
        wire: (w) => {
          w.query.push(["location", ""])
        },
      })
      await s.req("ignored param", {
        method: "GET",
        path: keyPath(b, "k"),
        auth: "v2",
        wire: (w) => {
          w.query.push(["foo", "bar"])
        },
      })
      await s.req("missing bucket", {
        method: "GET",
        path: keyPath("auth-missing-bucket-zz", "k"),
        auth: "v2",
      })
      await s.req("content-md5 mismatch", {
        method: "PUT",
        path: keyPath(b, "x"),
        body: "x",
        auth: "v2",
        headers: { "content-md5": md5("y") },
      })
      await s.req("delete", { method: "DELETE", path: keyPath(b, "v2 ü"), auth: "v2" })
    },
  },
  {
    name: "presigned-v2",
    async run(s) {
      const b = await seeded(s, "auth-pv2")
      await s.req("get", { method: "GET", path: keyPath(b, "k"), auth: "presign-v2" })
      await s.req("head", { method: "HEAD", path: keyPath(b, "k"), auth: "presign-v2" })
      await s.req("put", {
        method: "PUT",
        path: keyPath(b, "p"),
        body: "pv2",
        auth: "presign-v2",
        headers: { "content-type": "text/plain" },
      })
      await s.req("get p", { method: "GET", path: keyPath(b, "p") })
      await s.req("expired", {
        method: "GET",
        path: keyPath(b, "k"),
        auth: "presign-v2",
        date: PAST,
      })
      await s.req("far future", {
        method: "GET",
        path: keyPath(b, "k"),
        auth: "presign-v2",
        date: FUTURE,
      })
      await s.req("tampered", {
        method: "GET",
        path: keyPath(b, "k"),
        auth: "presign-v2",
        tamper: true,
      })
      await s.req("unknown key", {
        method: "GET",
        path: keyPath(b, "k"),
        auth: "presign-v2",
        credentials: UNKNOWN_KEY,
      })
      await s.req("malformed expires", {
        method: "GET",
        path: keyPath(b, "k"),
        auth: "presign-v2",
        wire: setQuery("Expires", "soon"),
      })
      await s.req("missing signature", {
        method: "GET",
        path: keyPath(b, "k"),
        auth: "presign-v2",
        wire: setQuery("Signature", undefined),
      })
      await s.req("missing expires", {
        method: "GET",
        path: keyPath(b, "k"),
        auth: "presign-v2",
        wire: setQuery("Expires", undefined),
      })
      await s.req("empty access key", {
        method: "GET",
        path: keyPath(b, "k"),
        auth: "presign-v2",
        wire: setQuery("AWSAccessKeyId", ""),
      })
      await s.req("extra param", {
        method: "GET",
        path: keyPath(b, "k"),
        auth: "presign-v2",
        wire: setQuery("foo", "bar"),
      })
      await s.req("missing bucket", {
        method: "GET",
        path: keyPath("auth-missing-bucket-zz", "k"),
        auth: "presign-v2",
      })
      await s.req("plus v4 header", {
        method: "GET",
        path: keyPath(b, "k"),
        auth: "presign-v2",
        wire: (w) => {
          w.headers.authorization = "AWS4-HMAC-SHA256 x"
        },
      })
    },
  },
  {
    name: "anonymous",
    async run(s) {
      const b = await seeded(s, "auth-anon")
      const missing = "auth-missing-bucket-zz"
      const anon = (step: string, spec: RequestSpec) => s.req(step, { ...spec, auth: "anonymous" })
      for (const [label, bucket] of [
        ["present", b],
        ["missing", missing],
      ] as const) {
        await anon(`${label}: get object`, { method: "GET", path: keyPath(bucket, "k") })
        await anon(`${label}: head object`, { method: "HEAD", path: keyPath(bucket, "k") })
        await anon(`${label}: put object`, {
          method: "PUT",
          path: keyPath(bucket, "anon"),
          body: "x",
        })
        await anon(`${label}: delete object`, { method: "DELETE", path: keyPath(bucket, "k") })
        await anon(`${label}: list objects`, { method: "GET", path: keyPath(bucket) })
        await anon(`${label}: list objects v2`, {
          method: "GET",
          path: keyPath(bucket),
          query: { "list-type": "2" },
        })
        await anon(`${label}: list versions`, {
          method: "GET",
          path: keyPath(bucket),
          query: { versions: "" },
        })
        await anon(`${label}: head bucket`, { method: "HEAD", path: keyPath(bucket) })
        await anon(`${label}: location`, {
          method: "GET",
          path: keyPath(bucket),
          query: { location: "" },
        })
        await anon(`${label}: delete bucket`, { method: "DELETE", path: keyPath(bucket) })
        await anon(`${label}: get versioning`, {
          method: "GET",
          path: keyPath(bucket),
          query: { versioning: "" },
        })
        await anon(`${label}: get policy`, {
          method: "GET",
          path: keyPath(bucket),
          query: { policy: "" },
        })
        await anon(`${label}: create upload`, {
          method: "POST",
          path: keyPath(bucket, "mp"),
          query: { uploads: "" },
        })
        await anon(`${label}: copy object`, {
          method: "PUT",
          path: keyPath(bucket, "copy"),
          headers: { "x-amz-copy-source": `/${b}/k` },
        })
      }
      await anon("create bucket", { method: "PUT", path: keyPath(s.name("auth-anon-new")) })
      await anon("list buckets", { method: "GET", path: "/" })
      await anon("head root", { method: "HEAD", path: "/" })
      await anon("invalid bucket name", { method: "GET", path: "/AB/k" })
      await anon("unicode key", { method: "GET", path: keyPath(b, "ü/ä b") })
      await s.req("still there", { method: "GET", path: keyPath(b, "k") })
    },
  },
  {
    name: "put-precedence",
    async run(s) {
      const b = await s.bucket("auth-put-order")
      const put = (step: string, spec: Partial<RequestSpec>) =>
        s.req(step, { method: "PUT", path: keyPath(b, "p"), body: "data", ...spec })
      await put("bad copy source + wrong secret", {
        headers: { "x-amz-copy-source": "nocopy" },
        credentials: WRONG_SECRET,
      })
      await put("bad copy source + anonymous", {
        headers: { "x-amz-copy-source": "nocopy" },
        auth: "anonymous",
      })
      await put("empty content-md5", { headers: { "content-md5": "" } })
      await put("bad md5 + skewed date", { headers: { "content-md5": "YWJj" }, date: PAST })
      await put("bad md5 + malformed auth", {
        headers: { "content-md5": "YWJj" },
        wire: authorization((v) => v.replace("Credential=", "Cred=")),
      })
      await put("unknown key + wrong region", { credentials: UNKNOWN_KEY, region: "eu-west-1" })
      await put("presigned wrong region", { auth: "presign", region: "eu-west-1" })
      await put("presigned unknown key", { auth: "presign", credentials: UNKNOWN_KEY })
      await put("presigned expired", { auth: "presign", date: PAST })
      await put("v2 malformed", { auth: "v2", wire: authorization(() => "AWS nocolon") })
      await put("bearer", { wire: authorization(() => "Bearer token") })
      await put("streaming decoded -1", {
        auth: "streaming",
        headers: { "x-amz-decoded-content-length": "-1" },
      })
      await put("streaming bad md5 + wrong secret", {
        auth: "streaming",
        headers: { "content-md5": "YWJj" },
        credentials: WRONG_SECRET,
      })
      await put("sha mismatch on missing bucket", {
        path: keyPath("auth-missing-bucket-zz", "p"),
        contentSha256: sha256("other"),
      })
      await put("bad hex on missing bucket", {
        path: keyPath("auth-missing-bucket-zz", "p"),
        contentSha256: "zz",
      })
      await put("anonymous missing bucket", {
        path: keyPath("auth-missing-bucket-zz", "p"),
        auth: "anonymous",
      })
      await s.req("nothing stored", { method: "HEAD", path: keyPath(b, "p") })
    },
  },
  {
    name: "upload-part-precedence",
    async run(s) {
      const b = await s.bucket("auth-part")
      const created = await s.raw({
        method: "POST",
        path: keyPath(b, "mp"),
        query: { uploads: "" },
      })
      const uploadId = created.tag("UploadId") ?? "missing"
      const part = (step: string, query: Record<string, string>, spec: Partial<RequestSpec>) =>
        s.req(step, {
          method: "PUT",
          path: keyPath(b, "mp"),
          query: { uploadId, ...query },
          body: "part data",
          ...spec,
        })
      await part("wrong secret", { partNumber: "1" }, { credentials: WRONG_SECRET })
      await part("anonymous", { partNumber: "1" }, { auth: "anonymous" })
      await part("unknown key", { partNumber: "1" }, { credentials: UNKNOWN_KEY })
      await part(
        "bad part number + wrong secret",
        { partNumber: "zero" },
        { credentials: WRONG_SECRET },
      )
      await part("part 0 + anonymous", { partNumber: "0" }, { auth: "anonymous" })
      await part(
        "part 10001 + wrong secret",
        { partNumber: "10001" },
        { credentials: WRONG_SECRET },
      )
      await part(
        "bad md5 + bad part number",
        { partNumber: "x" },
        { headers: { "content-md5": "YWJj" } },
      )
      await part(
        "copy source + bad md5",
        { partNumber: "1" },
        { headers: { "x-amz-copy-source": "nocopy", "content-md5": "YWJj" } },
      )
      await part(
        "streaming bad chunk signature",
        { partNumber: "1" },
        {
          auth: "streaming",
          wire: (w) => {
            const text = new TextDecoder("latin1").decode(w.body)
            w.body = new TextEncoder().encode(
              text.replace(
                /chunk-signature=([0-9a-f])/,
                (_, c: string) => `chunk-signature=${c === "0" ? "1" : "0"}`,
              ),
            )
          },
        },
      )
      await part("sha mismatch", { partNumber: "1" }, { contentSha256: sha256("other") })
      await part("md5 mismatch", { partNumber: "1" }, { headers: { "content-md5": md5("other") } })
    },
  },
  {
    name: "streaming-framing",
    async run(s) {
      const b = await s.bucket("auth-framing")
      const body = "abcdefghijklmnopqrst"
      const edit =
        (change: (text: string) => string): WireFn =>
        (wire) => {
          wire.body = new TextEncoder().encode(change(new TextDecoder("latin1").decode(wire.body)))
        }
      const put = (step: string, spec: Partial<RequestSpec>) =>
        s.req(step, { method: "PUT", path: keyPath(b, "f"), body, chunkSize: 8, ...spec })
      await put("signed: chunk too big", {
        auth: "streaming",
        wire: edit((t) => t.replace(/^8;/, "1000001;")),
      })
      await put("signed: uppercase hex size", {
        auth: "streaming",
        chunkSize: 10,
        wire: edit((t) => t.replace(/^a;/, "A;")),
      })
      await put("signed: no content-encoding", {
        auth: "streaming",
        signedHeaders: [
          "host",
          "x-amz-content-sha256",
          "x-amz-date",
          "x-amz-decoded-content-length",
        ],
        wire: (w) => {
          delete w.headers["content-encoding"]
        },
      })
      await s.req("get f", { method: "GET", path: keyPath(b, "f") })
      await put("signed: chunk extension spaces", {
        auth: "streaming",
        wire: edit((t) => t.replace(/^8;/, "8 ;")),
      })
      await put("signed: trailing bytes after final chunk", {
        auth: "streaming",
        wire: edit((t) => `${t}garbage`),
      })
      await put("unsigned: chunk-signature extension", {
        auth: "streaming-unsigned-trailer",
        trailer: ["x-amz-checksum-crc32", "AAAAAA=="],
        wire: edit((t) => t.replace(/^8\r\n/, "8;chunk-signature=00\r\n")),
      })
      await put("unsigned: chunk too big", {
        auth: "streaming-unsigned-trailer",
        trailer: ["x-amz-checksum-crc32", "AAAAAA=="],
        wire: edit((t) => t.replace(/^8\r\n/, "1000001\r\n")),
      })
      await put("unsigned: missing CRLF", {
        auth: "streaming-unsigned-trailer",
        trailer: ["x-amz-checksum-crc32", "AAAAAA=="],
        wire: edit((t) => t.replace("abcdefgh\r\n", "abcdefghXX")),
      })
      await put("unsigned: unknown trailer", {
        auth: "streaming-unsigned-trailer",
        trailer: ["x-amz-checksum-crc32", "AAAAAA=="],
        wire: edit((t) => t.replace("x-amz-checksum-crc32:", "x-amz-checksum-sha1:")),
      })
      await put("unsigned: uppercase trailer name", {
        auth: "streaming-unsigned-trailer",
        trailer: ["x-amz-checksum-crc32", "AAAAAA=="],
        wire: edit((t) => t.replace("x-amz-checksum-crc32:", "X-Amz-Checksum-Crc32:")),
      })
      await put("unsigned: invalid trailer base64", {
        auth: "streaming-unsigned-trailer",
        trailer: ["x-amz-checksum-crc32", "!!"],
      })
      await put("streaming on POST is header auth", {
        method: "POST",
        path: keyPath(b, "f"),
        query: { uploads: "" },
        auth: "streaming",
      })
      await s.req("streaming GET is header auth", {
        method: "GET",
        path: keyPath(b, "f"),
        auth: "streaming",
      })
    },
  },
  {
    name: "anonymous-like-schemes",
    async run(s) {
      const b = await seeded(s, "auth-sts")
      await s.req("sts action query", {
        method: "GET",
        path: keyPath(b, "k"),
        auth: "anonymous",
        query: { Action: "AssumeRole" },
      })
      await s.req("bearer head", {
        method: "HEAD",
        path: keyPath(b, "k"),
        auth: "anonymous",
        headers: { authorization: "Bearer x" },
      })
      await s.req("bearer list buckets", {
        method: "GET",
        path: "/",
        auth: "anonymous",
        headers: { authorization: "Bearer x" },
      })
      await s.req("empty authorization", {
        method: "GET",
        path: keyPath(b, "k"),
        auth: "anonymous",
        headers: { authorization: "" },
      })
      await s.req("form content-type on GET", {
        method: "GET",
        path: keyPath(b, "k"),
        auth: "anonymous",
        headers: { "content-type": "multipart/form-data; boundary=x" },
      })
      await s.req("form POST to create upload", {
        method: "POST",
        path: keyPath(b, "k"),
        query: { uploads: "" },
        auth: "anonymous",
        headers: { "content-type": "multipart/form-data; boundary=x" },
      })
      await s.req("unknown scheme on invalid bucket", {
        method: "GET",
        path: "/AB/k",
        auth: "anonymous",
        headers: { authorization: "Digest x" },
      })
    },
  },
  {
    name: "multiple-auth",
    async run(s) {
      const b = await seeded(s, "auth-multi")
      await s.req("header + presign", {
        method: "GET",
        path: keyPath(b, "k"),
        auth: "presign",
        wire: (w) => {
          w.headers.authorization = "AWS4-HMAC-SHA256 Credential=x, SignedHeaders=host, Signature=y"
        },
      })
      await s.req("header + presign v2", {
        method: "GET",
        path: keyPath(b, "k"),
        query: { AWSAccessKeyId: "x" },
      })
      await s.req("v2 header + v4 query", {
        method: "GET",
        path: keyPath(b, "k"),
        auth: "v2",
        wire: setQuery("X-Amz-Credential", "x"),
      })
      await s.req("presign v2 + v4", {
        method: "GET",
        path: keyPath(b, "k"),
        auth: "anonymous",
        query: { AWSAccessKeyId: "x", "X-Amz-Credential": "y" },
      })
      await s.req("header + post form", {
        method: "POST",
        path: keyPath(b),
        headers: { "content-type": "multipart/form-data; boundary=x" },
        body: "--x--\r\n",
      })
      await s.req("bad path wins", {
        method: "GET",
        path: `${keyPath(b)}/a/../k`,
        auth: "presign",
        wire: (w) => {
          w.headers.authorization = "AWS4-HMAC-SHA256 x"
        },
      })
      await s.req("credential param on anonymous", {
        method: "GET",
        path: keyPath(b, "k"),
        auth: "anonymous",
        query: { "X-Amz-Credential": "x" },
      })
    },
  },
]
