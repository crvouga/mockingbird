/** Bucket versioning: the configuration API and how writes, reads and deletes honor it. */
import { keyPath, type Res, type Scenario } from "../harness.js"

const XMLNS = "http://s3.amazonaws.com/doc/2006-03-01/"
/** A missing-but-well-formed version id. */
export const ABSENT_VERSION = "00000000-0000-4000-8000-000000000000"

export const versioningBody = (inner: string, xmlns = true) =>
  `<VersioningConfiguration${xmlns ? ` xmlns="${XMLNS}"` : ""}>${inner}</VersioningConfiguration>`

export const versionOf = (res: Res) => res.headers.get("x-amz-version-id") ?? ""

export const scenarios: Scenario[] = [
  {
    name: "get-never-set",
    async run(s) {
      const b = await s.bucket("ver-none")
      await s.req("get versioning", { method: "GET", path: keyPath(b), query: { versioning: "" } })
      await s.req("get versioning missing bucket", {
        method: "GET",
        path: keyPath(s.name("ver-nobucket")),
        query: { versioning: "" },
      })
      await s.req("put versioning missing bucket", {
        method: "PUT",
        path: keyPath(s.name("ver-nobucket2")),
        query: { versioning: "" },
        body: versioningBody("<Status>Enabled</Status>"),
      })
    },
  },
  {
    name: "enable-suspend",
    async run(s) {
      const b = await s.bucket("ver-states")
      const path = keyPath(b)
      const q = { versioning: "" }
      await s.req("enable", {
        method: "PUT",
        path,
        query: q,
        body: versioningBody("<Status>Enabled</Status>"),
      })
      await s.req("get enabled", { method: "GET", path, query: q })
      await s.req("suspend", {
        method: "PUT",
        path,
        query: q,
        body: versioningBody("<Status>Suspended</Status>"),
      })
      await s.req("get suspended", { method: "GET", path, query: q })
      await s.req("enable without xmlns", {
        method: "PUT",
        path,
        query: q,
        body: versioningBody("<Status>Enabled</Status>", false),
      })
      await s.req("get after no-xmlns put", { method: "GET", path, query: q })
      await s.req("enable with MFADelete", {
        method: "PUT",
        path,
        query: q,
        body: versioningBody("<Status>Enabled</Status><MfaDelete>Disabled</MfaDelete>"),
      })
      await s.req("get after mfa", { method: "GET", path, query: q })
      await s.req("enable with MFADelete enabled", {
        method: "PUT",
        path,
        query: q,
        body: versioningBody("<MFADelete>Enabled</MFADelete><Status>Suspended</Status>"),
      })
      await s.req("get after mfa enabled", { method: "GET", path, query: q })
    },
  },
  {
    name: "invalid-configs",
    async run(s) {
      const b = await s.bucket("ver-invalid")
      const path = keyPath(b)
      const q = { versioning: "" }
      const put = (step: string, body: string, headers?: Record<string, string>) =>
        s.req(step, { method: "PUT", path, query: q, body, ...(headers ? { headers } : {}) })
      await put("status Disabled", versioningBody("<Status>Disabled</Status>"))
      await put("status lowercase", versioningBody("<Status>enabled</Status>"))
      await put("status empty", versioningBody("<Status></Status>"))
      await put("no status", versioningBody(""))
      await put("empty body", "")
      await put("not xml", "versioning please")
      await put(
        "truncated xml",
        `<VersioningConfiguration xmlns="${XMLNS}"><Status>Enabled</Status>`,
      )
      await put("wrong root", `<Versioning xmlns="${XMLNS}"><Status>Enabled</Status></Versioning>`)
      await put(
        "mismatched tags",
        `<VersioningConfiguration><Status>Enabled</Stat></VersioningConfiguration>`,
      )
      await put(
        "suspended with excluded prefix",
        versioningBody(
          "<Status>Suspended</Status><ExcludedPrefixes><Prefix>tmp/</Prefix></ExcludedPrefixes>",
        ),
      )
      await put(
        "too many excluded prefixes",
        versioningBody(
          `<Status>Enabled</Status>${Array.from({ length: 11 }, (_, i) => `<ExcludedPrefixes><Prefix>p${i}/</Prefix></ExcludedPrefixes>`).join("")}`,
        ),
      )
      await s.req("get still unset", { method: "GET", path, query: q })
    },
  },
  {
    name: "excluded-prefixes",
    async run(s) {
      const b = await s.bucket("ver-excl")
      const path = keyPath(b)
      const q = { versioning: "" }
      await s.req("enable with prefixes", {
        method: "PUT",
        path,
        query: q,
        body: versioningBody(
          `<Status>Enabled</Status>${Array.from({ length: 10 }, (_, i) => `<ExcludedPrefixes><Prefix>p${i}/</Prefix></ExcludedPrefixes>`).join("")}<ExcludeFolders>true</ExcludeFolders>`,
        ),
      })
      await s.req("get with prefixes", { method: "GET", path, query: q })
      await s.req("put excluded", { method: "PUT", path: keyPath(b, "p3/a.txt"), body: "one" })
      await s.req("put excluded again", {
        method: "PUT",
        path: keyPath(b, "p3/a.txt"),
        body: "two",
      })
      await s.req("get excluded null", {
        method: "GET",
        path: keyPath(b, "p3/a.txt"),
        query: { versionId: "null" },
      })
      await s.req("put folder", { method: "PUT", path: keyPath(b, "dir/"), body: "" })
      await s.req("put versioned", { method: "PUT", path: keyPath(b, "q/a.txt"), body: "one" })
      await s.req("delete excluded", { method: "DELETE", path: keyPath(b, "p3/a.txt") })
      await s.req("get excluded after delete", { method: "GET", path: keyPath(b, "p3/a.txt") })
      await s.req("delete folder", { method: "DELETE", path: keyPath(b, "dir/") })
      await s.req("head folder after delete", { method: "HEAD", path: keyPath(b, "dir/") })
      await s.req("delete versioned", { method: "DELETE", path: keyPath(b, "q/a.txt") })
      await s.req("prefix not ending in slash", {
        method: "PUT",
        path,
        query: q,
        body: versioningBody(
          "<Status>Enabled</Status><ExcludedPrefixes><Prefix>logs</Prefix></ExcludedPrefixes>",
        ),
      })
      await s.req("get prefix not ending in slash", { method: "GET", path, query: q })
      await s.req("exclude folders false", {
        method: "PUT",
        path,
        query: q,
        body: versioningBody("<Status>Enabled</Status><ExcludeFolders>false</ExcludeFolders>"),
      })
      await s.req("get exclude folders false", { method: "GET", path, query: q })
    },
  },
  {
    name: "lock-bucket-versioning",
    async run(s) {
      const b = await s.bucket("ver-lock", { objectLock: true })
      const path = keyPath(b)
      const q = { versioning: "" }
      await s.req("get lock bucket versioning", { method: "GET", path, query: q })
      await s.req("suspend lock bucket", {
        method: "PUT",
        path,
        query: q,
        body: versioningBody("<Status>Suspended</Status>"),
      })
      await s.req("exclude folders on lock bucket", {
        method: "PUT",
        path,
        query: q,
        body: versioningBody("<Status>Enabled</Status><ExcludeFolders>true</ExcludeFolders>"),
      })
      await s.req("invalid status on lock bucket", {
        method: "PUT",
        path,
        query: q,
        body: versioningBody("<Status>Off</Status>"),
      })
      await s.req("enable lock bucket", {
        method: "PUT",
        path,
        query: q,
        body: versioningBody("<Status>Enabled</Status>"),
      })
      await s.req("get after", { method: "GET", path, query: q })
    },
  },
  {
    name: "unversioned-writes",
    async run(s) {
      const b = await s.bucket("ver-off")
      const k = keyPath(b, "k.txt")
      await s.req("put", { method: "PUT", path: k, body: "one" })
      await s.req("put again", { method: "PUT", path: k, body: "two" })
      await s.req("get", { method: "GET", path: k })
      await s.req("get versionId=null", { method: "GET", path: k, query: { versionId: "null" } })
      await s.req("head versionId=null", { method: "HEAD", path: k, query: { versionId: "null" } })
      await s.req("get absent version", {
        method: "GET",
        path: k,
        query: { versionId: ABSENT_VERSION },
      })
      await s.req("head absent version", {
        method: "HEAD",
        path: k,
        query: { versionId: ABSENT_VERSION },
      })
      await s.req("get malformed version", { method: "GET", path: k, query: { versionId: "abc" } })
      await s.req("head malformed version", {
        method: "HEAD",
        path: k,
        query: { versionId: "abc" },
      })
      await s.req("get empty version", { method: "GET", path: k, query: { versionId: "" } })
      await s.req("delete absent version", {
        method: "DELETE",
        path: k,
        query: { versionId: ABSENT_VERSION },
      })
      await s.req("delete malformed version", {
        method: "DELETE",
        path: k,
        query: { versionId: "abc" },
      })
      await s.req("delete null version", {
        method: "DELETE",
        path: k,
        query: { versionId: "null" },
      })
      await s.req("get after null delete", { method: "GET", path: k })
      await s.req("put then plain delete", { method: "PUT", path: k, body: "three" })
      await s.req("plain delete", { method: "DELETE", path: k })
      await s.req("get after plain delete", { method: "GET", path: k })
      await s.req("delete again", { method: "DELETE", path: k })
    },
  },
  {
    name: "enabled-writes",
    async run(s) {
      const b = await s.bucket("ver-on", { versioning: "Enabled" })
      const k = keyPath(b, "k.txt")
      const v1 = versionOf(await s.req("put v1", { method: "PUT", path: k, body: "one" }))
      const v2 = versionOf(await s.req("put v2", { method: "PUT", path: k, body: "two" }))
      await s.req("get latest", { method: "GET", path: k })
      await s.req("head latest", { method: "HEAD", path: k })
      await s.req("get v1", { method: "GET", path: k, query: { versionId: v1 } })
      await s.req("head v1", { method: "HEAD", path: k, query: { versionId: v1 } })
      await s.req("get v2", { method: "GET", path: k, query: { versionId: v2 } })
      await s.req("get null (absent)", { method: "GET", path: k, query: { versionId: "null" } })
      await s.req("head null (absent)", { method: "HEAD", path: k, query: { versionId: "null" } })
      await s.req("get absent", { method: "GET", path: k, query: { versionId: ABSENT_VERSION } })
      await s.req("get uppercase id", {
        method: "GET",
        path: k,
        query: { versionId: v1.toUpperCase() },
      })
      await s.req("get version on other key", {
        method: "GET",
        path: keyPath(b, "other"),
        query: { versionId: v1 },
      })
      await s.req("delete v2", { method: "DELETE", path: k, query: { versionId: v2 } })
      await s.req("get latest after v2 gone", { method: "GET", path: k })
      await s.req("get v2 after delete", { method: "GET", path: k, query: { versionId: v2 } })
      await s.req("delete v2 again", { method: "DELETE", path: k, query: { versionId: v2 } })
      await s.req("delete v1", { method: "DELETE", path: k, query: { versionId: v1 } })
      await s.req("get after all gone", { method: "GET", path: k })
      await s.req("head after all gone", { method: "HEAD", path: k })
    },
  },
  {
    name: "delete-markers",
    async run(s) {
      const b = await s.bucket("ver-dm", { versioning: "Enabled" })
      const k = keyPath(b, "doc.txt")
      const v1 = versionOf(await s.req("put", { method: "PUT", path: k, body: "hello" }))
      const dm = versionOf(await s.req("delete creates marker", { method: "DELETE", path: k }))
      await s.req("get latest is marker", { method: "GET", path: k })
      await s.req("head latest is marker", { method: "HEAD", path: k })
      await s.req("get marker by id", { method: "GET", path: k, query: { versionId: dm } })
      await s.req("head marker by id", { method: "HEAD", path: k, query: { versionId: dm } })
      await s.req("get v1 still there", { method: "GET", path: k, query: { versionId: v1 } })
      const dm2 = versionOf(
        await s.req("delete again stacks marker", { method: "DELETE", path: k }),
      )
      await s.req("delete newest marker", { method: "DELETE", path: k, query: { versionId: dm2 } })
      await s.req("get still marker", { method: "GET", path: k })
      await s.req("delete marker restores", { method: "DELETE", path: k, query: { versionId: dm } })
      await s.req("get restored", { method: "GET", path: k })
      await s.req("head restored", { method: "HEAD", path: k })
      await s.req("delete missing key makes marker", {
        method: "DELETE",
        path: keyPath(b, "never"),
      })
      await s.req("get missing key marker", { method: "GET", path: keyPath(b, "never") })
    },
  },
  {
    name: "suspended-writes",
    async run(s) {
      const b = await s.bucket("ver-susp", { versioning: "Enabled" })
      const k = keyPath(b, "k")
      const v1 = versionOf(await s.req("put enabled", { method: "PUT", path: k, body: "one" }))
      await s.raw({
        method: "PUT",
        path: keyPath(b),
        query: { versioning: "" },
        body: versioningBody("<Status>Suspended</Status>"),
      })
      await s.req("put suspended", { method: "PUT", path: k, body: "two" })
      await s.req("put suspended overwrite", { method: "PUT", path: k, body: "three" })
      await s.req("get latest", { method: "GET", path: k })
      await s.req("get null", { method: "GET", path: k, query: { versionId: "null" } })
      await s.req("head null", { method: "HEAD", path: k, query: { versionId: "null" } })
      await s.req("get v1", { method: "GET", path: k, query: { versionId: v1 } })
      await s.req("delete suspended makes null marker", { method: "DELETE", path: k })
      await s.req("get after null marker", { method: "GET", path: k })
      await s.req("head after null marker", { method: "HEAD", path: k })
      await s.req("get null marker by id", { method: "GET", path: k, query: { versionId: "null" } })
      await s.req("head null marker by id", {
        method: "HEAD",
        path: k,
        query: { versionId: "null" },
      })
      await s.req("get v1 after marker", { method: "GET", path: k, query: { versionId: v1 } })
      await s.req("delete null marker", { method: "DELETE", path: k, query: { versionId: "null" } })
      await s.req("get after removing marker", { method: "GET", path: k })
      await s.req("delete suspended twice", { method: "DELETE", path: k })
      await s.req("delete suspended thrice", { method: "DELETE", path: k })
      await s.req("put after marker", { method: "PUT", path: k, body: "four" })
      await s.req("get after put", { method: "GET", path: k })
      await s.raw({
        method: "PUT",
        path: keyPath(b),
        query: { versioning: "" },
        body: versioningBody("<Status>Enabled</Status>"),
      })
      await s.req("put re-enabled", { method: "PUT", path: k, body: "five" })
      await s.req("get null after re-enable", {
        method: "GET",
        path: k,
        query: { versionId: "null" },
      })
      await s.req("delete re-enabled", { method: "DELETE", path: k })
      await s.req("list versions", { method: "GET", path: keyPath(b), query: { versions: "" } })
    },
  },
  {
    name: "null-version-survives-enable",
    async run(s) {
      const b = await s.bucket("ver-pre")
      const k = keyPath(b, "k")
      await s.req("put unversioned", { method: "PUT", path: k, body: "pre" })
      await s.raw({
        method: "PUT",
        path: keyPath(b),
        query: { versioning: "" },
        body: versioningBody("<Status>Enabled</Status>"),
      })
      const v1 = versionOf(await s.req("put versioned", { method: "PUT", path: k, body: "post" }))
      await s.req("get null", { method: "GET", path: k, query: { versionId: "null" } })
      await s.req("get latest", { method: "GET", path: k })
      await s.req("delete v1", { method: "DELETE", path: k, query: { versionId: v1 } })
      await s.req("get latest is null again", { method: "GET", path: k })
      await s.req("head latest is null again", { method: "HEAD", path: k })
      await s.req("delete null", { method: "DELETE", path: k, query: { versionId: "null" } })
      await s.req("get gone", { method: "GET", path: k })
    },
  },
  {
    name: "special-keys",
    async run(s) {
      const b = await s.bucket("ver-keys", { versioning: "Enabled" })
      for (const key of [
        "ünï cødé/ключ.txt",
        "a&b<c>'\"d",
        "deep/nested/path/x",
        "with space+plus",
      ]) {
        const k = keyPath(b, key)
        const v = versionOf(await s.req(`put ${key}`, { method: "PUT", path: k, body: key }))
        await s.req(`delete ${key}`, { method: "DELETE", path: k })
        await s.req(`get marker ${key}`, { method: "GET", path: k })
        await s.req(`get version ${key}`, { method: "GET", path: k, query: { versionId: v } })
      }
    },
  },
]
