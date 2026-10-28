import { keyPath, type Scenario } from "../harness.js"

const bytes = (text: string) => new TextEncoder().encode(text)
const PAST = "Mon, 01 Jan 2001 00:00:00 GMT"
const FUTURE = "Fri, 01 Jan 2100 00:00:00 GMT"
/** md5("hello") — the ETag of the object every scenario writes. */
const ETAG = '"5d41402abc4b2a76b9719d911017c592"'
const OTHER = '"00000000000000000000000000000000"'

/** One object with cache headers, so 304/412 responses show which headers MinIO keeps. */
const setup = async (s: Parameters<Scenario["run"]>[0], base = "cond") => {
  const b = await s.bucket(base)
  await s.raw({
    method: "PUT",
    path: keyPath(b, "k"),
    body: bytes("hello"),
    headers: {
      "content-type": "text/plain",
      "cache-control": "max-age=10",
      expires: "Thu, 01 Jan 2099 00:00:00 GMT",
      "content-disposition": "inline",
      "x-amz-meta-a": "1",
    },
  })
  return b
}

type Case = [step: string, headers: Record<string, string>]

const both = async (s: Parameters<Scenario["run"]>[0], b: string, cases: Case[]) => {
  for (const [step, headers] of cases) {
    await s.req(`get ${step}`, { method: "GET", path: keyPath(b, "k"), headers })
    await s.req(`head ${step}`, { method: "HEAD", path: keyPath(b, "k"), headers })
  }
}

export const scenarios: Scenario[] = [
  {
    name: "if-match",
    async run(s) {
      const b = await setup(s)
      await both(s, b, [
        ["matching quoted", { "if-match": ETAG }],
        ["matching unquoted", { "if-match": ETAG.slice(1, -1) }],
        ["star", { "if-match": "*" }],
        ["star padded", { "if-match": "  *  " }],
        ["mismatch", { "if-match": OTHER }],
        ["list containing match", { "if-match": `${OTHER}, ${ETAG}` }],
        ["weak", { "if-match": `W/${ETAG}` }],
        ["empty", { "if-match": "" }],
      ])
    },
  },
  {
    name: "if-none-match",
    async run(s) {
      const b = await setup(s)
      await both(s, b, [
        ["matching", { "if-none-match": ETAG }],
        ["unquoted", { "if-none-match": ETAG.slice(1, -1) }],
        ["star", { "if-none-match": "*" }],
        ["mismatch", { "if-none-match": OTHER }],
        ["list", { "if-none-match": `${OTHER}, ${ETAG}` }],
      ])
    },
  },
  {
    name: "if-modified-since",
    async run(s) {
      const b = await setup(s)
      await both(s, b, [
        ["past", { "if-modified-since": PAST }],
        ["future", { "if-modified-since": FUTURE }],
        ["single digit day", { "if-modified-since": "Fri, 1 Jan 2100 00:00:00 GMT" }],
        ["malformed", { "if-modified-since": "yesterday" }],
        ["iso format", { "if-modified-since": "2100-01-01T00:00:00Z" }],
        ["rfc850", { "if-modified-since": "Friday, 01-Jan-00 00:00:00 GMT" }],
        ["ansi c", { "if-modified-since": "Fri Jan  1 00:00:00 2100" }],
        ["numeric zone", { "if-modified-since": "Fri, 01 Jan 2100 00:00:00 +0000" }],
        ["lowercase names", { "if-modified-since": "fri, 01 jan 2100 00:00:00 GMT" }],
        ["wrong weekday", { "if-modified-since": "Mon, 01 Jan 2100 00:00:00 GMT" }],
        ["day out of range", { "if-modified-since": "Mon, 31 Feb 2100 00:00:00 GMT" }],
      ])
    },
  },
  {
    name: "if-unmodified-since",
    async run(s) {
      const b = await setup(s)
      await both(s, b, [
        ["past", { "if-unmodified-since": PAST }],
        ["future", { "if-unmodified-since": FUTURE }],
        ["malformed", { "if-unmodified-since": "garbage" }],
      ])
    },
  },
  {
    name: "precedence",
    async run(s) {
      const b = await setup(s)
      await both(s, b, [
        // If-None-Match is evaluated first: a match is 304 regardless of the rest.
        ["none-match hit + match miss", { "if-none-match": ETAG, "if-match": OTHER }],
        [
          "none-match miss + modified-since future",
          { "if-none-match": OTHER, "if-modified-since": FUTURE },
        ],
        [
          "none-match hit + modified-since past",
          { "if-none-match": ETAG, "if-modified-since": PAST },
        ],
        ["modified-since future + match miss", { "if-modified-since": FUTURE, "if-match": OTHER }],
        ["match hit + unmodified-since past", { "if-match": ETAG, "if-unmodified-since": PAST }],
        [
          "match miss + unmodified-since future",
          { "if-match": OTHER, "if-unmodified-since": FUTURE },
        ],
        ["match hit + none-match miss", { "if-match": ETAG, "if-none-match": OTHER }],
        [
          "all pass",
          {
            "if-match": ETAG,
            "if-none-match": OTHER,
            "if-modified-since": PAST,
            "if-unmodified-since": FUTURE,
          },
        ],
        [
          "modified-since past + unmodified-since past",
          { "if-modified-since": PAST, "if-unmodified-since": PAST },
        ],
      ])
    },
  },
  {
    name: "conditions-with-range",
    async run(s) {
      const b = await setup(s)
      await s.req("range + if-match hit", {
        method: "GET",
        path: keyPath(b, "k"),
        headers: { range: "bytes=0-1", "if-match": ETAG },
      })
      await s.req("range + if-match miss", {
        method: "GET",
        path: keyPath(b, "k"),
        headers: { range: "bytes=0-1", "if-match": OTHER },
      })
      await s.req("range + none-match hit", {
        method: "GET",
        path: keyPath(b, "k"),
        headers: { range: "bytes=0-1", "if-none-match": ETAG },
      })
      await s.req("bad range + if-match miss", {
        method: "GET",
        path: keyPath(b, "k"),
        headers: { range: "bytes=9-10", "if-match": OTHER },
      })
      await s.req("partNumber + none-match hit", {
        method: "GET",
        path: keyPath(b, "k"),
        query: { partNumber: "1" },
        headers: { "if-none-match": ETAG },
      })
      await s.req("partNumber 2 + none-match hit", {
        method: "GET",
        path: keyPath(b, "k"),
        query: { partNumber: "2" },
        headers: { "if-none-match": ETAG },
      })
    },
  },
  {
    name: "conditions-on-missing",
    async run(s) {
      const b = await s.bucket("cond")
      await s.req("get if-match missing", {
        method: "GET",
        path: keyPath(b, "nope"),
        headers: { "if-match": ETAG },
      })
      await s.req("head if-none-match missing", {
        method: "HEAD",
        path: keyPath(b, "nope"),
        headers: { "if-none-match": "*" },
      })
    },
  },
  {
    name: "versioned-304",
    async run(s) {
      const b = await s.bucket("cond", { versioning: "Enabled" })
      await s.raw({ method: "PUT", path: keyPath(b, "k"), body: bytes("hello") })
      await s.req("get 304", {
        method: "GET",
        path: keyPath(b, "k"),
        headers: { "if-none-match": ETAG },
      })
      await s.req("head 412", {
        method: "HEAD",
        path: keyPath(b, "k"),
        headers: { "if-match": OTHER },
      })
      await s.req("get 412", {
        method: "GET",
        path: keyPath(b, "k"),
        headers: { "if-match": OTHER },
      })
    },
  },
  {
    name: "put-if-none-match",
    async run(s) {
      const b = await s.bucket("cond")
      await s.req("create when absent", {
        method: "PUT",
        path: keyPath(b, "k"),
        body: bytes("hello"),
        headers: { "if-none-match": "*" },
      })
      await s.req("create when present", {
        method: "PUT",
        path: keyPath(b, "k"),
        body: bytes("again"),
        headers: { "if-none-match": "*" },
      })
      await s.req("none-match etag hit", {
        method: "PUT",
        path: keyPath(b, "k"),
        body: bytes("again"),
        headers: { "if-none-match": ETAG },
      })
      await s.req("none-match etag miss", {
        method: "PUT",
        path: keyPath(b, "k"),
        body: bytes("again"),
        headers: { "if-none-match": OTHER },
      })
      await s.req("get", { method: "GET", path: keyPath(b, "k") })
    },
  },
  {
    name: "put-if-match",
    async run(s) {
      const b = await s.bucket("cond")
      await s.req("if-match on absent", {
        method: "PUT",
        path: keyPath(b, "k"),
        body: bytes("hello"),
        headers: { "if-match": ETAG },
      })
      await s.req("if-match star on absent", {
        method: "PUT",
        path: keyPath(b, "k"),
        body: bytes("hello"),
        headers: { "if-match": "*" },
      })
      await s.raw({ method: "PUT", path: keyPath(b, "k"), body: bytes("hello") })
      await s.req("if-match hit", {
        method: "PUT",
        path: keyPath(b, "k"),
        body: bytes("world"),
        headers: { "if-match": ETAG },
      })
      await s.req("if-match stale", {
        method: "PUT",
        path: keyPath(b, "k"),
        body: bytes("again"),
        headers: { "if-match": ETAG },
      })
      await s.req("if-match star present", {
        method: "PUT",
        path: keyPath(b, "k"),
        body: bytes("star"),
        headers: { "if-match": "*" },
      })
      await s.req("get", { method: "GET", path: keyPath(b, "k") })
      // Date conditions are ignored on PUT.
      await s.req("if-unmodified-since past", {
        method: "PUT",
        path: keyPath(b, "k"),
        body: bytes("date"),
        headers: { "if-unmodified-since": PAST },
      })
    },
  },
  {
    name: "put-conditional-versioned",
    async run(s) {
      const b = await s.bucket("cond", { versioning: "Enabled" })
      await s.raw({ method: "PUT", path: keyPath(b, "k"), body: bytes("hello") })
      await s.req("if-none-match star present", {
        method: "PUT",
        path: keyPath(b, "k"),
        body: bytes("x"),
        headers: { "if-none-match": "*" },
      })
      await s.raw({ method: "DELETE", path: keyPath(b, "k") })
      await s.req("if-none-match star after delete marker", {
        method: "PUT",
        path: keyPath(b, "k"),
        body: bytes("x"),
        headers: { "if-none-match": "*" },
      })
      await s.raw({ method: "DELETE", path: keyPath(b, "k") })
      await s.req("if-match after delete marker", {
        method: "PUT",
        path: keyPath(b, "k"),
        body: bytes("x"),
        headers: { "if-match": ETAG },
      })
    },
  },
]
