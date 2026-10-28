/**
 * Bucket tagging (Put/Get/DeleteBucketTagging) and object tagging (Put/Get/DeleteObjectTagging):
 * minio-go's `tags` validation (50 bucket / 10 object tags, key 128 / value 256 characters, the
 * allowed character set, duplicates), versions, delete markers, and `x-amz-tagging-count`.
 * MinIO writes a bucket's tags in Go map order, so multi-tag bucket GETs are recorded sorted.
 */
import { type Ctx, keyPath, type Scenario } from "../harness.js"

const tagging = (tags: [string, string][]) =>
  `<Tagging><TagSet>${tags.map(([key, value]) => `<Tag><Key>${key}</Key><Value>${value}</Value></Tag>`).join("")}</TagSet></Tagging>`
const many = (count: number, prefix = "k") =>
  Array.from(
    { length: count },
    (_, index) => [`${prefix}${index}`, `v${index}`] as [string, string],
  )

/** GET a bucket's tags and record them sorted (MinIO's order is random). */
const recordBucketTags = async (s: Ctx, step: string, bucket: string) => {
  const res = await s.raw({ method: "GET", path: keyPath(bucket), query: { tagging: "" } })
  const keys = res.tags("Key")
  const values = res.tags("Value")
  s.record(step, {
    status: res.status,
    code: res.tag("Code") ?? null,
    tags: keys.map((key, index) => `${key}=${values[index]}`).sort(),
  })
}

export const scenarios: Scenario[] = [
  {
    name: "bucket-put-get-delete",
    async run(s) {
      const b = await s.bucket("btag")
      await s.req("get none", { method: "GET", path: keyPath(b), query: { tagging: "" } })
      await s.req("delete none", { method: "DELETE", path: keyPath(b), query: { tagging: "" } })
      await s.req("put one", {
        method: "PUT",
        path: keyPath(b),
        query: { tagging: "" },
        body: tagging([["env", "prod"]]),
      })
      await s.req("get one", { method: "GET", path: keyPath(b), query: { tagging: "" } })
      await s.req("put special", {
        method: "PUT",
        path: keyPath(b),
        query: { tagging: "" },
        body: tagging([["a+b-c_d.e:f/g@h i=j", "x+y-z_w.v:u/t@s r=q"]]),
      })
      await s.req("get special", { method: "GET", path: keyPath(b), query: { tagging: "" } })
      await s.req("put empty value", {
        method: "PUT",
        path: keyPath(b),
        query: { tagging: "" },
        body: tagging([["k", ""]]),
      })
      await s.req("get empty value", { method: "GET", path: keyPath(b), query: { tagging: "" } })
      await s.req("put no value element", {
        method: "PUT",
        path: keyPath(b),
        query: { tagging: "" },
        body: "<Tagging><TagSet><Tag><Key>solo</Key></Tag></TagSet></Tagging>",
      })
      await s.req("get no value element", {
        method: "GET",
        path: keyPath(b),
        query: { tagging: "" },
      })
      await s.req("put fifty", {
        method: "PUT",
        path: keyPath(b),
        query: { tagging: "" },
        body: tagging(many(50)),
      })
      await recordBucketTags(s, "get fifty", b)
      await s.req("put with namespace", {
        method: "PUT",
        path: keyPath(b),
        query: { tagging: "" },
        body: `<?xml version="1.0" encoding="UTF-8"?>\n<Tagging xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><TagSet><Tag><Key>ns</Key><Value>1</Value></Tag></TagSet></Tagging>`,
      })
      await s.req("get with namespace", { method: "GET", path: keyPath(b), query: { tagging: "" } })
      await s.req("put empty tagset", {
        method: "PUT",
        path: keyPath(b),
        query: { tagging: "" },
        body: tagging([]),
      })
      await s.req("get empty tagset", { method: "GET", path: keyPath(b), query: { tagging: "" } })
      await s.req("delete", { method: "DELETE", path: keyPath(b), query: { tagging: "" } })
      await s.req("get deleted", { method: "GET", path: keyPath(b), query: { tagging: "" } })
      await s.req("head", { method: "HEAD", path: keyPath(b), query: { tagging: "" } })
    },
  },
  {
    name: "bucket-put-invalid",
    async run(s) {
      const b = await s.bucket("btag-bad")
      const put = (step: string, body: string) =>
        s.req(step, { method: "PUT", path: keyPath(b), query: { tagging: "" }, body })
      await put("fifty one", tagging(many(51)))
      await put(
        "duplicate keys",
        tagging([
          ["a", "1"],
          ["a", "2"],
        ]),
      )
      await put("empty key", tagging([["", "1"]]))
      await put("key 128", tagging([["k".repeat(128), "v"]]))
      await put("key 129", tagging([["k".repeat(129), "v"]]))
      await put("value 256", tagging([["k", "v".repeat(256)]]))
      await put("value 257", tagging([["k", "v".repeat(257)]]))
      await put("key bad char", tagging([["a*b", "1"]]))
      await put("value bad char", tagging([["a", "1#2"]]))
      await put("unicode key", tagging([["ключ", "1"]]))
      await put("bad key before too many", tagging([...many(51), ["bad!", "x"]]))
      await put(
        "dup and bad",
        tagging([
          ["a", "1"],
          ["a", "2"],
          ["bad!", "x"],
        ]),
      )
      await put("not xml", "not xml")
      await put("wrong root", "<Tags><TagSet></TagSet></Tags>")
      await put("no tagset", "<Tagging></Tagging>")
      await put("truncated", "<Tagging><TagSet>")
      await s.req("empty body", {
        method: "PUT",
        path: keyPath(b),
        query: { tagging: "" },
        body: "",
      })
      await s.req("get after failures", { method: "GET", path: keyPath(b), query: { tagging: "" } })
    },
  },
  {
    name: "bucket-missing",
    async run(s) {
      const b = s.name("btag-gone")
      await s.req("put", {
        method: "PUT",
        path: keyPath(b),
        query: { tagging: "" },
        body: tagging([["a", "1"]]),
      })
      await s.req("put invalid", {
        method: "PUT",
        path: keyPath(b),
        query: { tagging: "" },
        body: "nope",
      })
      await s.req("get", { method: "GET", path: keyPath(b), query: { tagging: "" } })
      await s.req("delete", { method: "DELETE", path: keyPath(b), query: { tagging: "" } })
    },
  },
  {
    name: "object-put-get-delete",
    async run(s) {
      const b = await s.bucket("otag")
      await s.raw({ method: "PUT", path: keyPath(b, "k"), body: "data" })
      await s.req("get none", { method: "GET", path: keyPath(b, "k"), query: { tagging: "" } })
      await s.req("put", {
        method: "PUT",
        path: keyPath(b, "k"),
        query: { tagging: "" },
        body: tagging([
          ["z", "last"],
          ["a", "first"],
          ["m", "mid"],
        ]),
      })
      await s.req("get sorted", { method: "GET", path: keyPath(b, "k"), query: { tagging: "" } })
      await s.req("head count", { method: "HEAD", path: keyPath(b, "k") })
      await s.req("get object count", { method: "GET", path: keyPath(b, "k") })
      await s.req("put ten", {
        method: "PUT",
        path: keyPath(b, "k"),
        query: { tagging: "" },
        body: tagging(many(10)),
      })
      await s.req("get ten", { method: "GET", path: keyPath(b, "k"), query: { tagging: "" } })
      await s.req("put special", {
        method: "PUT",
        path: keyPath(b, "k"),
        query: { tagging: "" },
        body: tagging([
          ["a b", "c+d"],
          ["e=f", "g/h"],
          ["empty", ""],
        ]),
      })
      await s.req("get special", { method: "GET", path: keyPath(b, "k"), query: { tagging: "" } })
      await s.req("put empty", {
        method: "PUT",
        path: keyPath(b, "k"),
        query: { tagging: "" },
        body: tagging([]),
      })
      await s.req("get after empty", {
        method: "GET",
        path: keyPath(b, "k"),
        query: { tagging: "" },
      })
      await s.req("head after empty", { method: "HEAD", path: keyPath(b, "k") })
      await s.req("put again", {
        method: "PUT",
        path: keyPath(b, "k"),
        query: { tagging: "" },
        body: tagging([["x", "1"]]),
      })
      await s.req("delete", { method: "DELETE", path: keyPath(b, "k"), query: { tagging: "" } })
      await s.req("get deleted", { method: "GET", path: keyPath(b, "k"), query: { tagging: "" } })
      await s.req("delete again", {
        method: "DELETE",
        path: keyPath(b, "k"),
        query: { tagging: "" },
      })
      await s.raw({ method: "PUT", path: keyPath(b, "dir/ü ñ+.txt"), body: "u" })
      await s.req("put unicode key", {
        method: "PUT",
        path: keyPath(b, "dir/ü ñ+.txt"),
        query: { tagging: "" },
        body: tagging([["t", "1"]]),
      })
      await s.req("get unicode key", {
        method: "GET",
        path: keyPath(b, "dir/ü ñ+.txt"),
        query: { tagging: "" },
      })
    },
  },
  {
    name: "object-put-invalid",
    async run(s) {
      const b = await s.bucket("otag-bad")
      await s.raw({ method: "PUT", path: keyPath(b, "k"), body: "data" })
      const put = (step: string, body: string) =>
        s.req(step, { method: "PUT", path: keyPath(b, "k"), query: { tagging: "" }, body })
      await put("eleven", tagging(many(11)))
      await put(
        "duplicate",
        tagging([
          ["a", "1"],
          ["a", "1"],
        ]),
      )
      await put("empty key", tagging([["", "v"]]))
      await put("key 129", tagging([["k".repeat(129), "v"]]))
      await put("value 257", tagging([["k", "v".repeat(257)]]))
      await put("bad char", tagging([["k", "a<b"]]))
      await put("bad char amp", tagging([["k&amp;", "v"]]))
      await put("not xml", "garbage")
      await put("truncated", "<Tagging><TagSet><Tag>")
      await put("wrong root", "<Other/>")
      await s.req("empty body", {
        method: "PUT",
        path: keyPath(b, "k"),
        query: { tagging: "" },
        body: "",
      })
      await s.req("get after failures", {
        method: "GET",
        path: keyPath(b, "k"),
        query: { tagging: "" },
      })
      await s.req("invalid on missing key", {
        method: "PUT",
        path: keyPath(b, "missing"),
        query: { tagging: "" },
        body: tagging(many(11)),
      })
    },
  },
  {
    name: "object-missing",
    async run(s) {
      const b = await s.bucket("otag-miss")
      await s.req("get missing key", {
        method: "GET",
        path: keyPath(b, "nope"),
        query: { tagging: "" },
      })
      await s.req("put missing key", {
        method: "PUT",
        path: keyPath(b, "nope"),
        query: { tagging: "" },
        body: tagging([["a", "1"]]),
      })
      await s.req("delete missing key", {
        method: "DELETE",
        path: keyPath(b, "nope"),
        query: { tagging: "" },
      })
      const gone = s.name("otag-gone")
      await s.req("get missing bucket", {
        method: "GET",
        path: keyPath(gone, "k"),
        query: { tagging: "" },
      })
      await s.req("put missing bucket", {
        method: "PUT",
        path: keyPath(gone, "k"),
        query: { tagging: "" },
        body: tagging([["a", "1"]]),
      })
      await s.req("delete missing bucket", {
        method: "DELETE",
        path: keyPath(gone, "k"),
        query: { tagging: "" },
      })
      await s.raw({ method: "PUT", path: keyPath(b, "k"), body: "data" })
      await s.req("bad version id", {
        method: "GET",
        path: keyPath(b, "k"),
        query: { tagging: "", versionId: "nope" },
      })
      await s.req("null version id", {
        method: "GET",
        path: keyPath(b, "k"),
        query: { tagging: "", versionId: "null" },
      })
      await s.req("uuid version id", {
        method: "GET",
        path: keyPath(b, "k"),
        query: { tagging: "", versionId: "8b3a1c5e-0000-4000-8000-000000000000" },
      })
    },
  },
  {
    name: "object-versions",
    async run(s) {
      const b = await s.bucket("otag-ver", { versioning: "Enabled" })
      const first = await s.raw({
        method: "PUT",
        path: keyPath(b, "k"),
        body: "one",
        headers: { "x-amz-tagging": "gen=1" },
      })
      const second = await s.raw({ method: "PUT", path: keyPath(b, "k"), body: "two" })
      const v1 = first.headers.get("x-amz-version-id") ?? ""
      const v2 = second.headers.get("x-amz-version-id") ?? ""
      await s.req("get v1", {
        method: "GET",
        path: keyPath(b, "k"),
        query: { tagging: "", versionId: v1 },
      })
      await s.req("get latest", { method: "GET", path: keyPath(b, "k"), query: { tagging: "" } })
      await s.req("put v1", {
        method: "PUT",
        path: keyPath(b, "k"),
        query: { tagging: "", versionId: v1 },
        body: tagging([["gen", "one"]]),
      })
      await s.req("put latest", {
        method: "PUT",
        path: keyPath(b, "k"),
        query: { tagging: "" },
        body: tagging([["gen", "two"]]),
      })
      await s.req("get v1 after", {
        method: "GET",
        path: keyPath(b, "k"),
        query: { tagging: "", versionId: v1 },
      })
      await s.req("get v2 after", {
        method: "GET",
        path: keyPath(b, "k"),
        query: { tagging: "", versionId: v2 },
      })
      await s.req("head v1 count", {
        method: "HEAD",
        path: keyPath(b, "k"),
        query: { versionId: v1 },
      })
      await s.req("delete v1", {
        method: "DELETE",
        path: keyPath(b, "k"),
        query: { tagging: "", versionId: v1 },
      })
      await s.req("get v1 deleted", {
        method: "GET",
        path: keyPath(b, "k"),
        query: { tagging: "", versionId: v1 },
      })
      await s.req("get v2 kept", {
        method: "GET",
        path: keyPath(b, "k"),
        query: { tagging: "", versionId: v2 },
      })
      await s.raw({ method: "DELETE", path: keyPath(b, "k") })
      await s.req("get delete marker", {
        method: "GET",
        path: keyPath(b, "k"),
        query: { tagging: "" },
      })
      await s.req("put delete marker", {
        method: "PUT",
        path: keyPath(b, "k"),
        query: { tagging: "" },
        body: tagging([["a", "1"]]),
      })
      await s.req("delete delete marker", {
        method: "DELETE",
        path: keyPath(b, "k"),
        query: { tagging: "" },
      })
      await s.req("get v2 under marker", {
        method: "GET",
        path: keyPath(b, "k"),
        query: { tagging: "", versionId: v2 },
      })
      const versions = await s.raw({ method: "GET", path: keyPath(b), query: { versions: "" } })
      const marker =
        versions.text.match(/<DeleteMarker>.*?<VersionId>([^<]+)<\/VersionId>/)?.[1] ?? ""
      await s.req("get marker by version", {
        method: "GET",
        path: keyPath(b, "k"),
        query: { tagging: "", versionId: marker },
      })
      await s.req("put marker by version", {
        method: "PUT",
        path: keyPath(b, "k"),
        query: { tagging: "", versionId: marker },
        body: tagging([["a", "1"]]),
      })
    },
  },
  {
    name: "object-put-with-header",
    async run(s) {
      const b = await s.bucket("otag-hdr")
      await s.req("put tagged", {
        method: "PUT",
        path: keyPath(b, "k"),
        body: "x",
        headers: { "x-amz-tagging": "b=2&a=1&c=" },
      })
      await s.req("get tags", { method: "GET", path: keyPath(b, "k"), query: { tagging: "" } })
      await s.req("head count", { method: "HEAD", path: keyPath(b, "k") })
      await s.req("put encoded", {
        method: "PUT",
        path: keyPath(b, "enc"),
        body: "x",
        headers: { "x-amz-tagging": "a%20b=c%2Bd&e=f%2Fg" },
      })
      await s.req("get encoded", { method: "GET", path: keyPath(b, "enc"), query: { tagging: "" } })
    },
  },
]
