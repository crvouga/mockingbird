/**
 * Bucket lifecycle (CreateBucket, HeadBucket, DeleteBucket, ListBuckets, GetBucketLocation),
 * MinIO's request-validity middlewares (`cmd/generic-handlers.go`) and routing fallbacks
 * (`cmd/api-router.go`): what a request is rejected for before any handler runs, and in which
 * order.
 */
import { type Ctx, keyPath, type RequestSpec, type Scenario } from "../harness.js"

const XMLNS = "http://s3.amazonaws.com/doc/2006-03-01/"
const config = (inner: string) => `<CreateBucketConfiguration>${inner}</CreateBucketConfiguration>`
const location = (region: string) => config(`<LocationConstraint>${region}</LocationConstraint>`)
const versioning = (status: string) =>
  `<VersioningConfiguration xmlns="${XMLNS}"><Status>${status}</Status></VersioningConfiguration>`
const FORCE = { "x-minio-force-delete": "true" }

/** The per-run suffix, for names `s.name` cannot build (it always appends `-<run>`). */
const runOf = (s: Ctx) => s.name("r").slice(2)
/** A fixed name (no run suffix) the scenario creates itself: removed before and after. */
const fixed = async (s: Ctx, name: string, body: (name: string) => Promise<void>) => {
  await s.raw({ method: "DELETE", path: `/${name}`, headers: FORCE })
  try {
    await body(name)
  } finally {
    await s.raw({ method: "DELETE", path: `/${name}`, headers: FORCE })
  }
}

/** Response headers worth comparing in a ListBuckets exchange recorded by `listMine`. */
const LIST_HEADERS = ["accept-ranges", "content-type", "x-amz-bucket-region", "x-amz-request-id"]

/**
 * ListBuckets sees every bucket on the server, including ones other scenarios (or other runs)
 * left behind on a shared MinIO. Record the exchange with only this run's buckets in the body.
 */
const listMine = async (s: Ctx, step: string, spec: RequestSpec) => {
  const run = runOf(s)
  const res = await s.raw(spec)
  const body = res.text
    .replace(/<Bucket><Name>([^<]*)<\/Name>.*?<\/Bucket>/g, (bucket, name: string) =>
      name.endsWith(`-${run}`) ? bucket : "",
    )
    .replace(/<CreationDate>[^<]*<\/CreationDate>/g, "<CreationDate><date></CreationDate>")
    .replace(/<RequestId>[^<]*<\/RequestId>/g, "<RequestId>*</RequestId>")
  const headers = Object.fromEntries(
    LIST_HEADERS.map((name) => [
      name,
      name === "x-amz-request-id" ? res.headers.has(name) : res.headers.get(name),
    ]),
  )
  s.record(step, { status: res.status, headers, body })
}

export const scenarios: Scenario[] = [
  // ── CreateBucket / HeadBucket / DeleteBucket / GetBucketLocation ───────────────────────────
  {
    name: "create-head-location-delete",
    async run(s) {
      const b = s.name("life")
      await s.req("head before", { method: "HEAD", path: keyPath(b) })
      await s.req("location before", { method: "GET", path: keyPath(b), query: { location: "" } })
      await s.req("create", { method: "PUT", path: keyPath(b) })
      await s.req("head", { method: "HEAD", path: keyPath(b) })
      await s.req("head trailing slash", { method: "HEAD", path: `${keyPath(b)}/` })
      await s.req("location", { method: "GET", path: keyPath(b), query: { location: "" } })
      await s.req("location trailing slash", {
        method: "GET",
        path: `${keyPath(b)}/`,
        query: { location: "" },
      })
      await s.req("create again", { method: "PUT", path: keyPath(b) })
      await s.req("create again trailing slash", { method: "PUT", path: `${keyPath(b)}/` })
      await s.req("delete", { method: "DELETE", path: keyPath(b) })
      await s.req("head after", { method: "HEAD", path: keyPath(b) })
      await s.req("delete again", { method: "DELETE", path: keyPath(b) })
      await s.req("location after", { method: "GET", path: keyPath(b), query: { location: "" } })
      await s.req("recreate", { method: "PUT", path: keyPath(b) })
      await s.req("head recreated", { method: "HEAD", path: keyPath(b) })
    },
  },
  {
    name: "presigned-create-head-delete",
    async run(s) {
      const b = s.name("presign")
      await s.req("create", { method: "PUT", path: keyPath(b), auth: "presign" })
      await s.req("create again", { method: "PUT", path: keyPath(b), auth: "presign" })
      await s.req("head", { method: "HEAD", path: keyPath(b), auth: "presign" })
      await s.req("delete", { method: "DELETE", path: keyPath(b), auth: "presign" })
      await s.req("delete again", { method: "DELETE", path: keyPath(b), auth: "presign" })
      await s.req("anonymous create", { method: "PUT", path: keyPath(b), auth: "anonymous" })
      await s.req("still missing", { method: "HEAD", path: keyPath(b) })
    },
  },
  {
    name: "create-empty-body-and-headers",
    async run(s) {
      const b = s.name("hdrs")
      await s.req("create with content-type", {
        method: "PUT",
        path: keyPath(b),
        body: "",
        headers: { "content-type": "application/xml" },
      })
      await s.req("head", { method: "HEAD", path: keyPath(b) })
      const c = s.name("acl")
      await s.req("x-amz-acl private", {
        method: "PUT",
        path: keyPath(c),
        headers: { "x-amz-acl": "private" },
      })
      const d = s.name("acl-public")
      await s.req("x-amz-acl public-read-write", {
        method: "PUT",
        path: keyPath(d),
        headers: { "x-amz-acl": "public-read-write" },
      })
      const e = s.name("acl-bogus")
      await s.req("x-amz-acl bogus", {
        method: "PUT",
        path: keyPath(e),
        headers: { "x-amz-acl": "bogus" },
      })
      const f = s.name("grant")
      await s.req("x-amz-grant-full-control", {
        method: "PUT",
        path: keyPath(f),
        headers: {
          "x-amz-grant-full-control": 'id="abc"',
          "x-amz-grant-read": "uri=http://acs.amazonaws.com/groups/global/AllUsers",
        },
      })
      await s.req("x-amz-acl on existing", {
        method: "PUT",
        path: keyPath(c),
        headers: { "x-amz-acl": "public-read" },
      })
      const g = s.name("ownership")
      await s.req("x-amz-object-ownership", {
        method: "PUT",
        path: keyPath(g),
        headers: { "x-amz-object-ownership": "BucketOwnerEnforced" },
      })
    },
  },
  {
    name: "create-object-lock-header",
    async run(s) {
      const bad = s.name("lock-bad")
      await s.req("lock yes", {
        method: "PUT",
        path: keyPath(bad),
        headers: { "x-amz-bucket-object-lock-enabled": "yes" },
      })
      await s.req("lock 1", {
        method: "PUT",
        path: keyPath(bad),
        headers: { "x-amz-bucket-object-lock-enabled": "1" },
      })
      await s.req("head after invalid", { method: "HEAD", path: keyPath(bad) })
      const off = s.name("lock-off")
      await s.req("lock false", {
        method: "PUT",
        path: keyPath(off),
        headers: { "x-amz-bucket-object-lock-enabled": "false" },
      })
      await s.req("lock False on existing", {
        method: "PUT",
        path: keyPath(off),
        headers: { "x-amz-bucket-object-lock-enabled": "False" },
      })
      await s.req("lock invalid on existing", {
        method: "PUT",
        path: keyPath(off),
        headers: { "x-amz-bucket-object-lock-enabled": "on" },
      })
      const empty = s.name("lock-empty")
      await s.req("lock empty value", {
        method: "PUT",
        path: keyPath(empty),
        headers: { "x-amz-bucket-object-lock-enabled": "" },
      })
      const on = s.name("lock-on")
      await s.req("lock TRUE", {
        method: "PUT",
        path: keyPath(on),
        headers: { "x-amz-bucket-object-lock-enabled": "TRUE" },
      })
      await s.req("head locked", { method: "HEAD", path: keyPath(on) })
      await s.req("force delete locked", { method: "DELETE", path: keyPath(on), headers: FORCE })
      await s.req("delete locked", { method: "DELETE", path: keyPath(on) })
      await s.req("anonymous lock invalid", {
        method: "PUT",
        path: keyPath(bad),
        auth: "anonymous",
        headers: { "x-amz-bucket-object-lock-enabled": "maybe" },
      })
    },
  },
  {
    name: "create-object-lock-enables-versioning",
    async run(s) {
      const on = s.name("lock-ver")
      await s.req("create locked", {
        method: "PUT",
        path: keyPath(on),
        headers: { "x-amz-bucket-object-lock-enabled": "true" },
      })
      await s.req("versioning", { method: "GET", path: keyPath(on), query: { versioning: "" } })
      const off = s.name("nolock-ver")
      await s.req("create plain", { method: "PUT", path: keyPath(off) })
      await s.req("versioning plain", {
        method: "GET",
        path: keyPath(off),
        query: { versioning: "" },
      })
    },
  },
  {
    name: "create-force-create-header",
    async run(s) {
      const b = s.name("force")
      await s.req("force-create new", {
        method: "PUT",
        path: keyPath(b),
        headers: { "x-minio-force-create": "true" },
      })
      await s.req("force-create existing", {
        method: "PUT",
        path: keyPath(b),
        headers: { "x-minio-force-create": "TRUE" },
      })
      await s.req("force-create false existing", {
        method: "PUT",
        path: keyPath(b),
        headers: { "x-minio-force-create": "false" },
      })
      await s.req("force-create invalid", {
        method: "PUT",
        path: keyPath(b),
        headers: { "x-minio-force-create": "yes" },
      })
      const c = s.name("force-bad")
      await s.req("force-create invalid new", {
        method: "PUT",
        path: keyPath(c),
        headers: { "x-minio-force-create": "1" },
      })
      await s.req("head never created", { method: "HEAD", path: keyPath(c) })
      await s.req("lock invalid wins over force invalid", {
        method: "PUT",
        path: keyPath(c),
        headers: { "x-amz-bucket-object-lock-enabled": "x", "x-minio-force-create": "y" },
      })
    },
  },
  {
    name: "create-location-constraint",
    async run(s) {
      const b = s.name("loc")
      await s.req("eu-west-1", { method: "PUT", path: keyPath(b), body: location("eu-west-1") })
      await s.req("EU", { method: "PUT", path: keyPath(b), body: location("EU") })
      await s.req("padded region", {
        method: "PUT",
        path: keyPath(b),
        body: location(" us-east-1 "),
      })
      await s.req("upper-case region", {
        method: "PUT",
        path: keyPath(b),
        body: location("US-EAST-1"),
      })
      await s.req("head after rejects", { method: "HEAD", path: keyPath(b) })
      await s.req("us-east-1 with xmlns", {
        method: "PUT",
        path: keyPath(b),
        body: `<?xml version="1.0" encoding="UTF-8"?>\n<CreateBucketConfiguration xmlns="${XMLNS}"><LocationConstraint>us-east-1</LocationConstraint></CreateBucketConfiguration>`,
      })
      await s.req("head", { method: "HEAD", path: keyPath(b) })
      await s.req("existing + wrong region", {
        method: "PUT",
        path: keyPath(b),
        body: location("eu-west-1"),
      })
      await s.req("existing + right region", {
        method: "PUT",
        path: keyPath(b),
        body: location("us-east-1"),
      })
      await s.req("existing + malformed", {
        method: "PUT",
        path: keyPath(b),
        body: "<CreateBucketConfiguration>",
      })
      const c = s.name("loc-empty")
      await s.req("self-closing config", {
        method: "PUT",
        path: keyPath(c),
        body: "<CreateBucketConfiguration/>",
      })
      const d = s.name("loc-blank")
      await s.req("empty LocationConstraint", {
        method: "PUT",
        path: keyPath(d),
        body: location(""),
      })
      const e = s.name("loc-ent")
      await s.req("entity-encoded region", {
        method: "PUT",
        path: keyPath(e),
        body: location("us&#45;east&#x2d;1"),
      })
      const f = s.name("loc-cdata")
      await s.req("cdata region", {
        method: "PUT",
        path: keyPath(f),
        body: location("<![CDATA[us-east-1]]>"),
      })
      const g = s.name("loc-split")
      await s.req("region split by element", {
        method: "PUT",
        path: keyPath(g),
        body: location("us-<b/>east<!-- x -->-1"),
      })
      await s.req("amp in region", {
        method: "PUT",
        path: keyPath(s.name("loc-amp")),
        body: location("us-east-1&amp;"),
      })
      await s.req("streaming body, wrong region", {
        method: "PUT",
        path: keyPath(s.name("loc-stream")),
        body: location("eu-west-1"),
        auth: "streaming",
      })
      await s.req("streaming body", {
        method: "PUT",
        path: keyPath(s.name("loc-stream")),
        body: location("us-east-1"),
        auth: "streaming",
        chunkSize: 16,
      })
      await s.req("unsigned payload, malformed", {
        method: "PUT",
        path: keyPath(s.name("loc-unsigned")),
        body: "<nope",
        auth: "unsigned-payload",
      })
      await s.req("wrong content-md5", {
        method: "PUT",
        path: keyPath(s.name("loc-md5")),
        body: location("us-east-1"),
        headers: { "content-md5": "1B2M2Y8AsgTpgAmY7PhCfg==" },
      })
      await s.req("head after wrong md5", { method: "HEAD", path: keyPath(s.name("loc-md5")) })
      await s.req("invalid content-md5", {
        method: "PUT",
        path: keyPath(s.name("loc-md5")),
        body: location("us-east-1"),
        headers: { "content-md5": "not-base64!" },
      })
      await s.req("wrong content-md5, unsigned payload", {
        method: "PUT",
        path: keyPath(s.name("loc-md5")),
        body: "<CreateBucketConfiguration/>",
        auth: "unsigned-payload",
        headers: { "content-md5": "AAAAAAAAAAAAAAAAAAAAAA==" },
      })
      await s.req("right content-md5", {
        method: "PUT",
        path: keyPath(s.name("loc-md5")),
        body: "<CreateBucketConfiguration/>",
        headers: { "content-md5": "FsxcrP6WXBS/SYrfnGdlGw==" },
      })
    },
  },
  {
    name: "create-location-constraint-xml-shapes",
    async run(s) {
      const cases: [string, string][] = [
        ["junk before root", "junk<CreateBucketConfiguration/>"],
        ["junk after root", "<CreateBucketConfiguration/>trailing <junk"],
        ["comment and pi before root", `<!-- c --><?xml version="1.0"?>${location("us-east-1")}`],
        ["doctype before root", "<!DOCTYPE x><CreateBucketConfiguration/>"],
        [
          "latin-1 declaration",
          '<?xml version="1.0" encoding="ISO-8859-1"?><CreateBucketConfiguration/>',
        ],
        [
          "prefixed names",
          '<s3:CreateBucketConfiguration xmlns:s3="x"><s3:LocationConstraint>us-east-1</s3:LocationConstraint></s3:CreateBucketConfiguration>',
        ],
        ["undeclared prefix", "<x:CreateBucketConfiguration/>"],
        ["duplicate attributes", '<CreateBucketConfiguration a="1" a="2"/>'],
        ["single-quoted attribute", "<CreateBucketConfiguration a='1'/>"],
        [
          "nested constraint ignored",
          config("<Foo><LocationConstraint>eu</LocationConstraint></Foo>"),
        ],
        [
          "unknown children",
          config("<Location>eu</Location><Bucket><Type>Directory</Type></Bucket>"),
        ],
        [
          "last constraint wins (eu)",
          config(
            "<LocationConstraint>us-east-1</LocationConstraint><LocationConstraint>eu</LocationConstraint>",
          ),
        ],
        [
          "last constraint wins (empty)",
          config("<LocationConstraint>eu</LocationConstraint><LocationConstraint/>"),
        ],
        [
          "whitespace around children",
          `\n  <CreateBucketConfiguration>\n  <LocationConstraint>us-east-1</LocationConstraint>\n</CreateBucketConfiguration>\n`,
        ],
        ["unknown entity", location("us&bogus;east-1")],
        ["bare ampersand", config("<LocationConstraint>us-east-1</LocationConstraint>&")],
        ["cdata end in text", config("<LocationConstraint>us-east-1</LocationConstraint>]]>")],
        ["mismatched end tag", "<CreateBucketConfiguration></Foo>"],
        [
          "mismatched inner end tag",
          config("<LocationConstraint>us-east-1</LocationConstraint><Foo></Bar>"),
        ],
        ["lower-case root", "<createbucketconfiguration/>"],
        ["wrong root", "<Foo/>"],
        [
          "unclosed root",
          "<CreateBucketConfiguration><LocationConstraint>us-east-1</LocationConstraint>",
        ],
        [
          "unterminated end tag",
          `${config("<LocationConstraint>us-east-1</LocationConstraint>").slice(0, -1)} `,
        ],
        ["unquoted attribute", "<CreateBucketConfiguration a=1/>"],
        ["bad element name", config("<1a/>")],
        ["control character", config("\u0001")],
        ["whitespace only", "   "],
        ["plain text", "garbage"],
        ["json", '{"LocationConstraint":"us-east-1"}'],
        ["bad comment", "<!-- a -- b --><CreateBucketConfiguration/>"],
        ["xml version 1.1", '<?xml version="1.1"?><CreateBucketConfiguration/>'],
      ]
      let index = 0
      for (const [step, body] of cases) {
        const b = s.name(`shape${index++}`)
        await s.req(step, { method: "PUT", path: keyPath(b), body })
      }
    },
  },
  {
    name: "create-bucket-name-length",
    async run(s) {
      const run = runOf(s)
      await s.req("2 chars", { method: "PUT", path: "/ab" })
      await s.req("2 chars head", { method: "HEAD", path: "/ab" })
      await s.req("1 char", { method: "PUT", path: "/a" })
      await fixed(s, "a1b", async (name) => {
        await s.req("3 chars", { method: "PUT", path: `/${name}` })
        await s.req("3 chars head", { method: "HEAD", path: `/${name}` })
        await s.req("3 chars delete", { method: "DELETE", path: `/${name}` })
      })
      const max = s.name("m".repeat(63 - 1 - run.length))
      await s.req("63 chars", { method: "PUT", path: keyPath(max) })
      await s.req("63 chars head", { method: "HEAD", path: keyPath(max) })
      const over = `${"o".repeat(64 - 1 - run.length)}-${run}`
      await s.req("64 chars", { method: "PUT", path: keyPath(over) })
      await s.req("64 chars head", { method: "HEAD", path: keyPath(over) })
      await s.req("64 chars delete", { method: "DELETE", path: keyPath(over) })
      await s.req("64 chars object", { method: "GET", path: keyPath(over, "k") })
      await s.req("100 chars", { method: "PUT", path: `/${"x".repeat(100)}` })
    },
  },
  {
    name: "create-bucket-name-characters",
    async run(s) {
      const run = runOf(s)
      const invalid: [string, string][] = [
        ["upper-case", `Upper-${run}`],
        ["all upper-case", `ABC-${run}`],
        ["underscore", `under_score-${run}`],
        ["colon", `co:lon-${run}`],
        ["leading hyphen", `-lead-${run}`],
        ["trailing hyphen", `trail-${run}-`],
        ["leading dot", `.lead-${run}`],
        ["trailing dot", `trail-${run}.`],
        ["double dot", `a..b-${run}`],
        ["dot hyphen", `a.-b-${run}`],
        ["hyphen dot", `a-.b-${run}`],
        ["ip address", "192.168.10.1"],
        ["ip-shaped out of range", "999.999.999.999"],
        ["space", `sp ace-${run}`],
        ["trailing space", `space-${run} `],
        ["unicode", `ünïcode-${run}`],
        ["exclamation", `bang!-${run}`],
        ["tilde", `til~de-${run}`],
      ]
      for (const [step, name] of invalid) {
        await s.req(`PUT ${step}`, { method: "PUT", path: keyPath(name) })
        await s.req(`HEAD ${step}`, { method: "HEAD", path: keyPath(name) })
      }
      await s.req("GET upper-case object", { method: "GET", path: keyPath(`Upper-${run}`, "k") })
      await s.req("DELETE underscore", { method: "DELETE", path: keyPath(`under_score-${run}`) })
      await s.req("GET ip location", {
        method: "GET",
        path: keyPath("192.168.10.1"),
        query: { location: "" },
      })
      for (const base of ["dots.in.name", "1.2.3.4", "123", "a-b-c", "x.y-z"]) {
        const name = s.name(base)
        await s.req(`PUT ${base}`, { method: "PUT", path: keyPath(name) })
        await s.req(`HEAD ${base}`, { method: "HEAD", path: keyPath(name) })
      }
    },
  },
  {
    name: "reserved-buckets",
    async run(s) {
      for (const method of ["PUT", "GET", "HEAD", "DELETE"])
        await s.req(`${method} /minio`, { method, path: "/minio" })
      await s.req("GET /minio?location", { method: "GET", path: "/minio", query: { location: "" } })
      await s.req("PUT /minio/k", { method: "PUT", path: "/minio/k", body: "x" })
      await s.req("HEAD /minio/k", { method: "HEAD", path: "/minio/k" })
      await s.req("DELETE /minio/k", { method: "DELETE", path: "/minio/k" })
      await s.req("GET /minio/k (rpc-shaped, reaches the handler)", {
        method: "GET",
        path: "/minio/k",
      })
      await s.req("GET /minio/ (rpc-shaped)", { method: "GET", path: "/minio/" })
      await s.req("PUT /.minio.sys", { method: "PUT", path: "/.minio.sys" })
      await s.req("GET /.minio.sys", { method: "GET", path: "/.minio.sys" })
      await s.req("HEAD /.minio.sys/k", { method: "HEAD", path: "/.minio.sys/k" })
      await s.req("PUT /MINIO", { method: "PUT", path: "/MINIO" })
      await s.req("PUT /minio1", { method: "PUT", path: "/minio1" })
      await s.req("DELETE /minio1", { method: "DELETE", path: "/minio1" })
      await s.req("anonymous GET /minio", { method: "GET", path: "/minio", auth: "anonymous" })
      await s.req("PUT /minio/.. bad path first", { method: "PUT", path: "/minio/a%5C..%5Cb" })
    },
  },
  {
    name: "head-bucket",
    async run(s) {
      const b = await s.bucket("head")
      await s.req("exists", { method: "HEAD", path: keyPath(b) })
      await s.req("with ?acl (HeadBucket wins)", {
        method: "HEAD",
        path: keyPath(b),
        query: { acl: "" },
      })
      await s.req("with ?versioning", {
        method: "HEAD",
        path: keyPath(b),
        query: { versioning: "" },
      })
      await s.req("with ?location", { method: "HEAD", path: keyPath(b), query: { location: "" } })
      await s.req("anonymous exists", { method: "HEAD", path: keyPath(b), auth: "anonymous" })
      await s.req("missing", { method: "HEAD", path: keyPath(s.name("head-missing")) })
      await s.req("anonymous missing", {
        method: "HEAD",
        path: keyPath(s.name("head-missing")),
        auth: "anonymous",
      })
      await s.req("presigned exists", { method: "HEAD", path: keyPath(b), auth: "presign" })
    },
  },
  {
    name: "get-bucket-location",
    async run(s) {
      const b = await s.bucket("where")
      await s.req("location", { method: "GET", path: keyPath(b), query: { location: "" } })
      await s.req("location=value", { method: "GET", path: keyPath(b), query: { location: "x" } })
      await s.req("location + acl (location first)", {
        method: "GET",
        path: keyPath(b),
        query: [
          ["acl", ""],
          ["location", ""],
        ],
      })
      await s.req("presigned", {
        method: "GET",
        path: keyPath(b),
        query: { location: "" },
        auth: "presign",
      })
      await s.req("anonymous", {
        method: "GET",
        path: keyPath(b),
        query: { location: "" },
        auth: "anonymous",
      })
      await s.req("missing", {
        method: "GET",
        path: keyPath(s.name("nowhere")),
        query: { location: "" },
      })
      await s.req("anonymous missing", {
        method: "GET",
        path: keyPath(s.name("nowhere")),
        query: { location: "" },
        auth: "anonymous",
      })
    },
  },
  // ── DeleteBucket ───────────────────────────────────────────────────────────────────────────
  {
    name: "delete-bucket-with-objects",
    async run(s) {
      const b = await s.bucket("del-objs")
      await s.raw({ method: "PUT", path: keyPath(b, "a.txt"), body: "a" })
      await s.raw({ method: "PUT", path: keyPath(b, "dir/b.txt"), body: "b" })
      await s.req("not empty", { method: "DELETE", path: keyPath(b) })
      await s.raw({ method: "DELETE", path: keyPath(b, "a.txt") })
      await s.req("still not empty", { method: "DELETE", path: keyPath(b) })
      await s.raw({ method: "DELETE", path: keyPath(b, "dir/b.txt") })
      await s.req("empty now", { method: "DELETE", path: keyPath(b) })
      await s.req("gone", { method: "HEAD", path: keyPath(b) })
      const c = await s.bucket("del-dir")
      await s.raw({ method: "PUT", path: keyPath(c, "folder/"), body: "" })
      await s.req("only a folder object", { method: "DELETE", path: keyPath(c) })
      const d = await s.bucket("del-anon")
      await s.req("anonymous", { method: "DELETE", path: keyPath(d), auth: "anonymous" })
      await s.req("anonymous missing", {
        method: "DELETE",
        path: keyPath(s.name("del-nope")),
        auth: "anonymous",
      })
      await s.req("missing", { method: "DELETE", path: keyPath(s.name("del-nope")) })
      await s.req("trailing slash", { method: "DELETE", path: `${keyPath(d)}/` })
      await s.req("gone after trailing slash", { method: "HEAD", path: keyPath(d) })
    },
  },
  {
    name: "delete-bucket-versioned",
    async run(s) {
      const b = await s.bucket("del-ver", { versioning: "Enabled" })
      const put = await s.raw({ method: "PUT", path: keyPath(b, "k"), body: "x" })
      const version = put.headers.get("x-amz-version-id") ?? ""
      const marker = await s.raw({ method: "DELETE", path: keyPath(b, "k") })
      const markerId = marker.headers.get("x-amz-version-id") ?? ""
      await s.req("version + delete marker", { method: "DELETE", path: keyPath(b) })
      await s.raw({ method: "DELETE", path: keyPath(b, "k"), query: { versionId: version } })
      await s.req("only a delete marker", { method: "DELETE", path: keyPath(b) })
      await s.raw({ method: "DELETE", path: keyPath(b, "k"), query: { versionId: markerId } })
      await s.req("no versions left", { method: "DELETE", path: keyPath(b) })
      await s.req("gone", { method: "HEAD", path: keyPath(b) })
    },
  },
  {
    name: "delete-bucket-suspended",
    async run(s) {
      const b = await s.bucket("del-sus")
      await s.raw({ method: "PUT", path: keyPath(b, "k"), body: "x" })
      await s.req("unversioned not empty", { method: "DELETE", path: keyPath(b) })
      await s.raw({
        method: "PUT",
        path: keyPath(b),
        query: { versioning: "" },
        body: versioning("Suspended"),
      })
      await s.req("suspended not empty", { method: "DELETE", path: keyPath(b) })
      await s.raw({ method: "DELETE", path: keyPath(b, "k"), query: { versionId: "null" } })
      await s.req("suspended emptied", { method: "DELETE", path: keyPath(b) })
    },
  },
  {
    name: "delete-bucket-only-multipart-uploads",
    async run(s) {
      const b = await s.bucket("del-mpu")
      await s.raw({ method: "POST", path: keyPath(b, "big"), query: { uploads: "" } })
      await s.raw({ method: "POST", path: keyPath(b, "other"), query: { uploads: "" } })
      await s.req("only incomplete uploads", { method: "DELETE", path: keyPath(b) })
      await s.req("gone", { method: "HEAD", path: keyPath(b) })
      await s.req("recreate", { method: "PUT", path: keyPath(b) })
      await s.req("uploads gone with it", {
        method: "GET",
        path: keyPath(b),
        query: { uploads: "" },
      })
    },
  },
  {
    name: "delete-bucket-force",
    async run(s) {
      const b = await s.bucket("force-del")
      await s.raw({ method: "PUT", path: keyPath(b, "a"), body: "a" })
      await s.req("force invalid", {
        method: "DELETE",
        path: keyPath(b),
        headers: { "x-minio-force-delete": "yes" },
      })
      await s.req("force invalid quoted", {
        method: "DELETE",
        path: keyPath(b),
        headers: { "x-minio-force-delete": 'a"b' },
      })
      await s.req("force 0", {
        method: "DELETE",
        path: keyPath(b),
        headers: { "x-minio-force-delete": "0" },
      })
      await s.req("force F", {
        method: "DELETE",
        path: keyPath(b),
        headers: { "x-minio-force-delete": "F" },
      })
      await s.req("force empty value", {
        method: "DELETE",
        path: keyPath(b),
        headers: { "x-minio-force-delete": "" },
      })
      await s.req("force T", {
        method: "DELETE",
        path: keyPath(b),
        headers: { "x-minio-force-delete": "T" },
      })
      await s.req("gone", { method: "HEAD", path: keyPath(b) })
      await s.req("force missing", {
        method: "DELETE",
        path: keyPath(b),
        headers: { "x-minio-force-delete": "1" },
      })
      await s.req("force false missing", {
        method: "DELETE",
        path: keyPath(b),
        headers: { "x-minio-force-delete": "false" },
      })
      await s.req("force invalid missing", {
        method: "DELETE",
        path: keyPath(b),
        headers: { "x-minio-force-delete": "nah" },
      })
      const v = await s.bucket("force-ver", { versioning: "Enabled" })
      await s.raw({ method: "PUT", path: keyPath(v, "k"), body: "1" })
      await s.raw({ method: "PUT", path: keyPath(v, "k"), body: "2" })
      await s.raw({ method: "DELETE", path: keyPath(v, "k") })
      await s.raw({ method: "POST", path: keyPath(v, "mpu"), query: { uploads: "" } })
      await s.req("force versioned", {
        method: "DELETE",
        path: keyPath(v),
        headers: { "x-minio-force-delete": "TRUE" },
      })
      await s.req("recreate", { method: "PUT", path: keyPath(v) })
      await s.req("recreated has no versions", {
        method: "GET",
        path: keyPath(v),
        query: { versioning: "" },
      })
      await s.req("delete recreated", { method: "DELETE", path: keyPath(v) })
      const a = await s.bucket("force-anon")
      await s.req("anonymous force", {
        method: "DELETE",
        path: keyPath(a),
        auth: "anonymous",
        headers: FORCE,
      })
    },
  },
  // ── ListBuckets ────────────────────────────────────────────────────────────────────────────
  {
    name: "list-buckets",
    async run(s) {
      await listMine(s, "none", { method: "GET", path: "/" })
      await s.bucket("zeta")
      await s.bucket("alpha")
      await s.bucket("alpha.beta")
      await s.bucket("alpha0")
      await s.bucket("1numeric")
      await listMine(s, "sorted", { method: "GET", path: "/" })
      await listMine(s, "max-buckets ignored", {
        method: "GET",
        path: "/",
        query: { "max-buckets": "1" },
      })
      await listMine(s, "prefix ignored", { method: "GET", path: "/", query: { prefix: "zeta" } })
      await listMine(s, "bucket-region ignored", {
        method: "GET",
        path: "/",
        query: { "bucket-region": "eu-west-1" },
      })
      await listMine(s, "unrelated query", {
        method: "GET",
        path: "/",
        query: { location: "", versions: "" },
      })
      await listMine(s, "presigned", { method: "GET", path: "/", auth: "presign" })
      await s.req("anonymous", { method: "GET", path: "/", auth: "anonymous" })
    },
  },
  {
    name: "list-buckets-after-delete",
    async run(s) {
      const a = await s.bucket("lb-a")
      await s.bucket("lb-b")
      await s.raw({ method: "DELETE", path: keyPath(a) })
      await listMine(s, "one left", { method: "GET", path: "/" })
      await s.req("double slash root (the client collapses it)", { method: "GET", path: "//" })
    },
  },
  // ── routing fallbacks ──────────────────────────────────────────────────────────────────────
  {
    name: "unsupported-routes",
    async run(s) {
      const b = await s.bucket("route")
      for (const method of ["POST", "PUT", "DELETE", "PATCH"])
        await s.req(`${method} /`, { method, path: "/" })
      await s.req("HEAD /", { method: "HEAD", path: "/" })
      await s.req("PATCH bucket", { method: "PATCH", path: keyPath(b) })
      await s.req("PATCH object", { method: "PATCH", path: keyPath(b, "a b'c&d") })
      await s.req("POST bucket, no query", { method: "POST", path: keyPath(b) })
      await s.req("POST bucket ?uploads", {
        method: "POST",
        path: keyPath(b),
        query: { uploads: "" },
      })
      await s.req("POST object, no query", { method: "POST", path: keyPath(b, "k") })
      await s.req("POST object ?select without select-type", {
        method: "POST",
        path: keyPath(b, "k"),
        query: { select: "" },
      })
      await s.req("POST object ?select-type=1", {
        method: "POST",
        path: keyPath(b, "k"),
        query: { select: "", "select-type": "1" },
      })
      await s.req("POST invalid bucket name", { method: "POST", path: "/AB_C" })
      await s.req("PATCH reserved bucket", { method: "PATCH", path: "/minio" })
      await s.req("POST bad path", { method: "POST", path: `${keyPath(b)}/a%5C..%5Cb` })
      await s.req("anonymous POST /", { method: "POST", path: "/", auth: "anonymous" })
      await s.req("POST / with reserved metadata", {
        method: "POST",
        path: "/",
        headers: { "x-minio-internal-x": "1" },
      })
      await s.req("POST bucket with write-offset", {
        method: "POST",
        path: keyPath(b),
        headers: { "x-amz-write-offset-bytes": "0" },
      })
      await s.req("OPTIONS /", { method: "OPTIONS", path: "/", auth: "anonymous" })
    },
  },
  {
    name: "append-object-route",
    async run(s) {
      const b = await s.bucket("append")
      await s.req("PUT with write-offset", {
        method: "PUT",
        path: keyPath(b, "k"),
        body: "x",
        headers: { "x-amz-write-offset-bytes": "0" },
      })
      await s.req("anonymous PUT with write-offset", {
        method: "PUT",
        path: keyPath(b, "k"),
        body: "x",
        auth: "anonymous",
        headers: { "x-amz-write-offset-bytes": "10" },
      })
      await s.req("missing bucket", {
        method: "PUT",
        path: keyPath(s.name("append-none"), "k"),
        body: "x",
        headers: { "x-amz-write-offset-bytes": "" },
      })
      await s.req("object not written", { method: "HEAD", path: keyPath(b, "k") })
    },
  },
  {
    name: "not-implemented-routes",
    async run(s) {
      const b = await s.bucket("noimpl")
      const bucketCases: [string, string][] = [
        ["GET", "inventory"],
        ["PUT", "inventory"],
        ["DELETE", "inventory"],
        ["GET", "metrics"],
        ["PUT", "website"],
        ["PUT", "logging"],
        ["DELETE", "logging"],
        ["PUT", "accelerate"],
        ["DELETE", "accelerate"],
        ["PUT", "requestPayment"],
        ["DELETE", "requestPayment"],
        ["DELETE", "acl"],
        ["GET", "publicAccessBlock"],
        ["PUT", "ownershipControls"],
        ["DELETE", "intelligent-tiering"],
        ["GET", "analytics"],
      ]
      for (const [method, name] of bucketCases)
        await s.req(`${method} ?${name}`, { method, path: keyPath(b), query: { [name]: "" } })
      await s.req("GET object ?torrent", {
        method: "GET",
        path: keyPath(b, "k"),
        query: { torrent: "" },
      })
      await s.req("PUT object ?torrent", {
        method: "PUT",
        path: keyPath(b, "k"),
        query: { torrent: "" },
        body: "x",
      })
      await s.req("DELETE object ?acl", {
        method: "DELETE",
        path: keyPath(b, "k"),
        query: { acl: "" },
      })
      await s.req("anonymous ?inventory", {
        method: "GET",
        path: keyPath(b),
        query: { inventory: "" },
        auth: "anonymous",
      })
      await s.req("missing bucket ?metrics", {
        method: "GET",
        path: keyPath(s.name("noimpl-x")),
        query: { metrics: "" },
      })
      await s.req("invalid bucket ?metrics", {
        method: "GET",
        path: "/AB_C",
        query: { metrics: "" },
      })
      await s.req("object not written", { method: "HEAD", path: keyPath(b, "k") })
    },
  },
  // ── setRequestValidityMiddleware ───────────────────────────────────────────────────────────
  {
    name: "bad-path-components",
    async run(s) {
      const b = await s.bucket("paths")
      await s.req("backslash dot-dot", { method: "GET", path: `${keyPath(b)}/a%5C..%5Cb` })
      await s.req("space-padded dot-dot", { method: "GET", path: `${keyPath(b)}/%20..%20/x` })
      await s.req("space-padded dot", { method: "PUT", path: `${keyPath(b)}/x/.%09`, body: "x" })
      await s.req("tab-padded dot head", { method: "HEAD", path: `${keyPath(b)}/%09.%09/k` })
      await s.req("dot-dot in bucket position", { method: "GET", path: "/%20..%20" })
      await s.req("backslash in bucket position", { method: "PUT", path: "/a%5C.%5Cb" })
      await s.req("bad path beats invalid name", { method: "GET", path: "/AB/%20.%20" })
      await s.req("bad path beats missing bucket", {
        method: "DELETE",
        path: `/${s.name("paths-x")}/%20..`,
      })
      await s.req("anonymous bad path", {
        method: "GET",
        path: `${keyPath(b)}/a%5C..`,
        auth: "anonymous",
      })
      await s.req("three dots are fine", { method: "GET", path: keyPath(b, "a/.../b") })
      await s.req("dots inside a segment are fine", { method: "GET", path: keyPath(b, "a/..b/c.") })
      await s.req("encoded dot-dot normalized by the client", {
        method: "GET",
        path: `${keyPath(b)}/x/%2e%2e/k`,
      })
      await s.req("double slash inside", { method: "GET", path: `${keyPath(b)}//k` })
      await s.req("PUT leading-slash key", {
        method: "PUT",
        path: `${keyPath(b)}//a//c/`,
        body: "x",
      })
      await s.req("stored as a/c/", { method: "HEAD", path: keyPath(b, "a/c/") })
      await s.req("GET leading-slash key", { method: "GET", path: `${keyPath(b)}///a/c/` })
    },
  },
  {
    name: "bad-query-values",
    async run(s) {
      const b = await s.bucket("queries")
      await s.req("prefix ..", { method: "GET", path: keyPath(b), query: { prefix: ".." } })
      await s.req("prefix .", {
        method: "GET",
        path: keyPath(b),
        query: { "list-type": "2", prefix: "." },
      })
      await s.req("prefix a/../b", { method: "GET", path: keyPath(b), query: { prefix: "a/../b" } })
      await s.req("start-after a\\..", {
        method: "GET",
        path: keyPath(b),
        query: { "list-type": "2", "start-after": "a\\.." },
      })
      await s.req("unknown param ..", {
        method: "GET",
        path: keyPath(b),
        query: { location: "", foo: ".." },
      })
      await s.req("param name .. is fine", {
        method: "GET",
        path: keyPath(b),
        query: { location: "", "..": "x" },
      })
      await s.req("delimiter .. is allowed", {
        method: "GET",
        path: keyPath(b),
        query: { location: "", delimiter: ".." },
      })
      await s.req("missing bucket", {
        method: "GET",
        path: keyPath(s.name("queries-x")),
        query: { prefix: ".." },
      })
      await s.req("anonymous", {
        method: "GET",
        path: keyPath(b),
        query: { prefix: "..", location: "" },
        auth: "anonymous",
      })
      await s.req("on HEAD bucket", { method: "HEAD", path: keyPath(b), query: { x: "./" } })
      await s.req("query beats invalid name", { method: "PUT", path: "/AB_C", query: { x: ".." } })
    },
  },
  {
    name: "very-long-path",
    skip: "a >32 KiB request line exceeds Node's 16 KiB header limit in the HTTP adapter (431 before S3API.fetch, which implements the check, sees it)",
    async run(s) {
      const b = await s.bucket("long")
      await s.req("path just over 32 KiB", {
        method: "GET",
        path: keyPath(b, "k".repeat(33 * 1024)),
      })
    },
  },
  {
    name: "multiple-auth-types",
    async run(s) {
      const b = await s.bucket("multi")
      await s.req("header + presign credential", {
        method: "GET",
        path: keyPath(b),
        query: { location: "", "X-Amz-Credential": "x" },
      })
      await s.req("header + v2 access key", {
        method: "HEAD",
        path: keyPath(b),
        query: { AWSAccessKeyId: "x" },
      })
      await s.req("multiple auth beats invalid name", {
        method: "PUT",
        path: "/AB_C",
        query: { "X-Amz-Credential": "x" },
      })
      await s.req("bad path beats multiple auth", {
        method: "PUT",
        path: "/AB_C/%20..",
        query: { "X-Amz-Credential": "x" },
      })
    },
  },
  // ── setRequestLimitMiddleware ──────────────────────────────────────────────────────────────
  {
    name: "header-limits",
    async run(s) {
      const missing = s.name("limits-x")
      const loc = { location: "" }
      await s.req("user metadata at 2048 bytes", {
        method: "GET",
        path: keyPath(missing),
        query: loc,
        headers: { "x-amz-meta-a": "v".repeat(2048 - "x-amz-meta-a".length) },
      })
      await s.req("user metadata at 2049 bytes", {
        method: "GET",
        path: keyPath(missing),
        query: loc,
        headers: { "x-amz-meta-a": "v".repeat(2049 - "x-amz-meta-a".length) },
      })
      await s.req("x-minio-meta counts too", {
        method: "GET",
        path: keyPath(missing),
        query: loc,
        headers: { "x-minio-meta-a": "v".repeat(2100) },
      })
      await s.req("several metadata headers", {
        method: "GET",
        path: keyPath(missing),
        query: loc,
        headers: Object.fromEntries(
          Array.from({ length: 5 }, (_, index) => [`x-amz-meta-h${index}`, "v".repeat(400)]),
        ),
      })
      await s.req("other headers 7000 bytes", {
        method: "GET",
        path: keyPath(missing),
        query: loc,
        headers: { "x-custom": "v".repeat(7000) },
      })
      await s.req("other headers 9000 bytes", {
        method: "GET",
        path: keyPath(missing),
        query: loc,
        headers: { "x-custom": "v".repeat(9000) },
      })
      await s.req("too large on HEAD", {
        method: "HEAD",
        path: keyPath(missing),
        headers: { "x-custom": "v".repeat(9000) },
      })
      await s.req("too large beats invalid name", {
        method: "GET",
        path: "/ab",
        headers: { "x-amz-meta-a": "v".repeat(3000) },
      })
      await s.req("too large beats bad path", {
        method: "GET",
        path: "/ab/%20..",
        headers: { "x-amz-meta-a": "v".repeat(3000) },
      })
      await s.req("anonymous too large", {
        method: "GET",
        path: keyPath(missing),
        auth: "anonymous",
        headers: { "x-amz-meta-a": "v".repeat(3000) },
      })
    },
  },
  {
    name: "reserved-metadata-headers",
    async run(s) {
      const missing = s.name("internal-x")
      await s.req("x-minio-internal-*", {
        method: "GET",
        path: keyPath(missing),
        query: { location: "" },
        headers: { "x-minio-internal-foo": "1" },
      })
      await s.req("on HEAD", {
        method: "HEAD",
        path: keyPath(missing),
        headers: { "X-Minio-Internal-Bar": "" },
      })
      await s.req("beats too large", {
        method: "GET",
        path: keyPath(missing),
        headers: { "x-minio-internal-foo": "1", "x-amz-meta-a": "v".repeat(3000) },
      })
      await s.req("beats invalid name", {
        method: "GET",
        path: "/ab",
        headers: { "x-minio-internal-foo": "1" },
      })
      await s.req("replication passthrough header is allowed", {
        method: "GET",
        path: keyPath(missing),
        query: { location: "" },
        headers: { "x-minio-internal-server-side-encryption-sealed-key": "x" },
      })
      await s.req("x-minio-replication-* is fine", {
        method: "GET",
        path: keyPath(missing),
        query: { location: "" },
        headers: { "x-minio-replication-foo": "1" },
      })
    },
  },
  {
    name: "sse-c-over-http",
    async run(s) {
      const b = await s.bucket("ssec")
      await s.req("customer algorithm on bucket GET", {
        method: "GET",
        path: keyPath(b),
        query: { location: "" },
        headers: { "x-amz-server-side-encryption-customer-algorithm": "AES256" },
      })
      await s.req("customer key on PUT object", {
        method: "PUT",
        path: keyPath(b, "k"),
        body: "x",
        headers: { "x-amz-server-side-encryption-customer-key": "a2V5" },
      })
      await s.req("customer key md5 on HEAD (headers only)", {
        method: "HEAD",
        path: keyPath(b, "k"),
        headers: { "x-amz-server-side-encryption-customer-key-md5": "x" },
      })
      await s.req("copy-source customer key", {
        method: "PUT",
        path: keyPath(b, "k2"),
        headers: {
          "x-amz-copy-source": `${b}/k`,
          "x-amz-copy-source-server-side-encryption-customer-algorithm": "AES256",
        },
      })
      await s.req("empty header value still counts", {
        method: "DELETE",
        path: keyPath(b),
        headers: { "x-amz-server-side-encryption-customer-key-md5": "" },
      })
      await s.req("anonymous", {
        method: "GET",
        path: keyPath(b, "k"),
        auth: "anonymous",
        headers: { "x-amz-server-side-encryption-customer-algorithm": "AES256" },
      })
      await s.req("invalid name beats sse-c", {
        method: "GET",
        path: "/ab",
        headers: { "x-amz-server-side-encryption-customer-algorithm": "AES256" },
      })
      await s.req("reserved bucket beats sse-c on HEAD", {
        method: "HEAD",
        path: "/minio",
        headers: { "x-amz-server-side-encryption-customer-algorithm": "AES256" },
      })
      await s.req("sse-s3 header is fine", {
        method: "GET",
        path: keyPath(b),
        query: { location: "" },
        headers: { "x-amz-server-side-encryption": "AES256" },
      })
      await s.req("object not written", { method: "HEAD", path: keyPath(b, "k") })
      await s.req("bucket not deleted", { method: "HEAD", path: keyPath(b) })
    },
  },
]
