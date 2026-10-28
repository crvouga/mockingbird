import { keyPath, type Scenario } from "../harness.js"

const bytes = (text: string) => new TextEncoder().encode(text)

/** GET and HEAD of the 10-byte object `0123456789` with each Range header. */
const ranges = (name: string, cases: string[], body = "0123456789"): Scenario => ({
  name,
  async run(s) {
    const b = await s.bucket("range")
    await s.raw({
      method: "PUT",
      path: keyPath(b, "k"),
      body: bytes(body),
      headers: { "content-type": "text/plain" },
    })
    for (const range of cases) {
      await s.req(`get ${range}`, { method: "GET", path: keyPath(b, "k"), headers: { range } })
      await s.req(`head ${range}`, { method: "HEAD", path: keyPath(b, "k"), headers: { range } })
    }
  },
})

export const scenarios: Scenario[] = [
  ranges("closed", [
    "bytes=0-0",
    "bytes=0-9",
    "bytes=2-4",
    "bytes=9-9",
    "bytes=5-100",
    "bytes=0-18446744073709551615",
  ]),
  ranges("open-ended", ["bytes=0-", "bytes=3-", "bytes=9-"]),
  ranges("suffix", ["bytes=-1", "bytes=-3", "bytes=-10", "bytes=-11", "bytes=-1000"]),
  ranges("unsatisfiable", ["bytes=10-", "bytes=10-20", "bytes=100-200", "bytes=-0", "bytes=5-2"]),
  ranges("ignored-malformed", [
    "bytes=abc",
    "bytes=-",
    "bytes=1",
    "bytes=+1-2",
    "bytes=1-+2",
    "bytes=a-b",
    "bytes= 1-2",
    "bytes=1-2 ",
    "items=0-1",
    "Bytes=0-1",
    "bytes=0-1,3-4",
    "bytes=0-1, 3-4",
    "bytes=-1-2",
    "",
  ]),
  ranges("empty-object", ["bytes=0-0", "bytes=0-", "bytes=-1", "bytes=-0", "bytes=0-10"], ""),
  ranges("large-values", [
    "bytes=9223372036854775807-",
    "bytes=9223372036854775808-",
    "bytes=-9223372036854775807",
  ]),
  {
    name: "versioned-range",
    async run(s) {
      const b = await s.bucket("range", { versioning: "Enabled" })
      const v1 = await s.raw({ method: "PUT", path: keyPath(b, "k"), body: bytes("first version") })
      await s.raw({ method: "PUT", path: keyPath(b, "k"), body: bytes("second") })
      const id = v1.headers.get("x-amz-version-id") ?? ""
      await s.req("range of v1", {
        method: "GET",
        path: keyPath(b, "k"),
        query: { versionId: id },
        headers: { range: "bytes=6-" },
      })
      await s.req("invalid range of v1", {
        method: "GET",
        path: keyPath(b, "k"),
        query: { versionId: id },
        headers: { range: "bytes=50-" },
      })
    },
  },
  {
    name: "range-on-missing",
    async run(s) {
      const b = await s.bucket("range")
      await s.req("missing key", {
        method: "GET",
        path: keyPath(b, "nope"),
        headers: { range: "bytes=0-1" },
      })
      await s.req("missing key reversed", {
        method: "GET",
        path: keyPath(b, "nope"),
        headers: { range: "bytes=5-1" },
      })
      await s.req("missing bucket", {
        method: "GET",
        path: keyPath(s.name("absent"), "nope"),
        headers: { range: "bytes=5-1" },
      })
    },
  },
  {
    name: "range-with-metadata",
    async run(s) {
      const b = await s.bucket("range")
      await s.raw({
        method: "PUT",
        path: keyPath(b, "k"),
        body: bytes("abcdefghij"),
        headers: {
          "x-amz-meta-x": "y",
          "cache-control": "no-cache",
          "x-amz-tagging": "a=b",
          "content-language": "de",
        },
      })
      await s.req("ranged get keeps object headers", {
        method: "GET",
        path: keyPath(b, "k"),
        headers: { range: "bytes=1-3" },
      })
    },
  },
]
