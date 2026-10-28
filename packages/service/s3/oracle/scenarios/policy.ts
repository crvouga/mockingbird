/**
 * Bucket policies: PutBucketPolicy validation (MinIO's `policy.ParseBucketPolicyConfig`), the
 * re-serialized document GetBucketPolicy answers, GetBucketPolicyStatus, and how a policy opens
 * the bucket to anonymous requests (Allow/Deny, wildcards, conditions).
 */
import { type Ctx, keyPath, type RequestSpec, type Scenario } from "../harness.js"

type Statement = Record<string, unknown>
const doc = (...statements: Statement[]) =>
  JSON.stringify({ Version: "2012-10-17", Statement: statements })
const allow = (action: string | string[], resource: string | string[], extra: Statement = {}) => ({
  Effect: "Allow",
  Principal: { AWS: ["*"] },
  Action: action,
  Resource: resource,
  ...extra,
})
const deny = (action: string | string[], resource: string | string[], extra: Statement = {}) => ({
  ...allow(action, resource, extra),
  Effect: "Deny",
})
const arn = (bucket: string, rest = "") => `arn:aws:s3:::${bucket}${rest}`
const putPolicy = (bucket: string, body: string): RequestSpec => ({
  method: "PUT",
  path: keyPath(bucket),
  query: { policy: "" },
  body,
})
const setPolicy = async (s: Ctx, bucket: string, body: string) => {
  const res = await s.raw(putPolicy(bucket, body))
  if (res.status !== 204) throw new Error(`setup: policy -> ${res.status} ${res.text}`)
}
const anon = (method: string, path: string, extra: Partial<RequestSpec> = {}): RequestSpec => ({
  method,
  path,
  auth: "anonymous",
  ...extra,
})

export const scenarios: Scenario[] = [
  {
    name: "put-get-delete",
    async run(s) {
      const b = await s.bucket("pol")
      await s.req("get none", { method: "GET", path: keyPath(b), query: { policy: "" } })
      await s.req("status none", { method: "GET", path: keyPath(b), query: { policyStatus: "" } })
      await s.req("delete none", { method: "DELETE", path: keyPath(b), query: { policy: "" } })
      await s.req("put", putPolicy(b, doc(allow("s3:GetObject", arn(b, "/*")))))
      await s.req("get", { method: "GET", path: keyPath(b), query: { policy: "" } })
      await s.req("status", { method: "GET", path: keyPath(b), query: { policyStatus: "" } })
      await s.req("replace", putPolicy(b, doc(allow("s3:ListBucket", arn(b)))))
      await s.req("get replaced", { method: "GET", path: keyPath(b), query: { policy: "" } })
      await s.req("delete", { method: "DELETE", path: keyPath(b), query: { policy: "" } })
      await s.req("get deleted", { method: "GET", path: keyPath(b), query: { policy: "" } })
      await s.req("head get", { method: "HEAD", path: keyPath(b), query: { policy: "" } })
    },
  },
  {
    name: "missing-bucket",
    async run(s) {
      const b = s.name("pol-missing")
      await s.req("put", putPolicy(b, doc(allow("s3:GetObject", arn(b, "/*")))))
      await s.req("get", { method: "GET", path: keyPath(b), query: { policy: "" } })
      await s.req("delete", { method: "DELETE", path: keyPath(b), query: { policy: "" } })
      await s.req("status", { method: "GET", path: keyPath(b), query: { policyStatus: "" } })
    },
  },
  {
    name: "status",
    async run(s) {
      const b = await s.bucket("pol-status")
      const status = () =>
        s.req("status", { method: "GET", path: keyPath(b), query: { policyStatus: "" } })
      await setPolicy(s, b, doc(allow("s3:GetObject", arn(b, "/*"))))
      await status()
      await setPolicy(s, b, doc(allow("s3:ListBucket", arn(b))))
      await status()
      await setPolicy(s, b, doc(allow("s3:PutObject", arn(b, "/*"))))
      await status()
      await setPolicy(
        s,
        b,
        doc(allow("s3:ListBucket", arn(b)), allow("s3:PutObject", arn(b, "/*"))),
      )
      await status()
      await setPolicy(s, b, doc(allow("s3:*", arn(b, "*"))))
      await status()
      await setPolicy(s, b, doc(allow("s3:*", arn(b, "*")), deny("s3:PutObject", arn(b, "/*"))))
      await status()
      await setPolicy(
        s,
        b,
        doc(
          allow("s3:ListBucket", arn(b), { Condition: { StringEquals: { "s3:prefix": "x/" } } }),
          allow("s3:PutObject", arn(b, "/*")),
        ),
      )
      await status()
    },
  },
  {
    name: "reserialized",
    async run(s) {
      const b = await s.bucket("pol-json")
      const get = (step: string) =>
        s.req(step, { method: "GET", path: keyPath(b), query: { policy: "" } })
      // Principal "*" becomes {"AWS":["*"]}, single strings become arrays, unknown fields drop.
      await s.req(
        "put shorthand",
        putPolicy(
          b,
          JSON.stringify({
            Version: "2012-10-17",
            Id: "my-id",
            Statement: [
              {
                Sid: "public <read> & 'more'",
                Effect: "Allow",
                Principal: "*",
                Action: "s3:GetObject",
                Resource: arn(b, "/*"),
              },
            ],
          }),
        ),
      )
      await get("get shorthand")
      await s.req(
        "put conditions",
        putPolicy(
          b,
          doc(
            allow("s3:ListBucket", arn(b), {
              Condition: {
                StringLike: { "s3:prefix": ["public/*"] },
                StringEquals: { "s3:delimiter": "/", "s3:max-keys": "10" },
              },
            }),
          ),
        ),
      )
      await get("get conditions")
      await s.req(
        "put duplicates",
        putPolicy(b, doc(allow("s3:GetObject", arn(b, "/*")), allow("s3:GetObject", arn(b, "/*")))),
      )
      await get("get duplicates")
      await s.req(
        "put lowercase fields",
        putPolicy(
          b,
          JSON.stringify({
            version: "2012-10-17",
            statement: [
              {
                effect: "Allow",
                principal: { aws: "*" },
                action: "s3:GetObject",
                resource: arn(b, "/*"),
              },
            ],
          }),
        ),
      )
      await get("get lowercase fields")
      await s.req(
        "put ip condition",
        putPolicy(
          b,
          doc(
            allow("s3:GetObject", arn(b, "/*"), {
              Condition: { IpAddress: { "aws:SourceIp": "10.0.0.0/8" } },
            }),
          ),
        ),
      )
      await get("get ip condition")
      await s.req(
        "put bool and numeric",
        putPolicy(
          b,
          doc(
            allow("s3:ListBucket", arn(b), {
              Condition: {
                Bool: { "aws:SecureTransport": false },
                NumericLessThan: { "s3:max-keys": 100 },
              },
            }),
          ),
        ),
      )
      await get("get bool and numeric")
      await s.req(
        "put wildcard bucket resource",
        putPolicy(b, doc(allow("s3:GetObject", arn("pol-json*", "/*")))),
      )
      await get("get wildcard bucket resource")
      await s.req("put star resource", putPolicy(b, doc(allow("s3:GetObject", "arn:aws:s3:::*"))))
      await get("get star resource")
      await s.req(
        "put no version field",
        putPolicy(b, JSON.stringify({ Statement: [allow("s3:GetObject", arn(b, "/*"))] })),
      )
    },
  },
  {
    name: "put-malformed",
    async run(s) {
      const b = await s.bucket("pol-bad")
      const put = (step: string, body: string) => s.req(step, putPolicy(b, body))
      await put("not json", "not json")
      await put("truncated", '{"Version":"2012-10-17"')
      await put("array", "[]")
      await put("string", '"policy"')
      await put("trailing garbage", `${doc(allow("s3:GetObject", arn(b, "/*")))}}`)
      await put("version number", '{"Version":1,"Statement":[]}')
      await put(
        "bad version",
        JSON.stringify({ Version: "2008-10-17", Statement: [allow("s3:GetObject", arn(b, "/*"))] }),
      )
      await put("empty statements", '{"Version":"2012-10-17","Statement":[]}')
      await s.req("get empty statements", {
        method: "GET",
        path: keyPath(b),
        query: { policy: "" },
      })
      await put("no statement", '{"Version":"2012-10-17"}')
      await s.req("get no statement", { method: "GET", path: keyPath(b), query: { policy: "" } })
      await put("null statement", '{"Version":"2012-10-17","Statement":null}')
      await s.req("get null statement", { method: "GET", path: keyPath(b), query: { policy: "" } })
      await put("statement object", '{"Version":"2012-10-17","Statement":{}}')
      await put("statement string", '{"Version":"2012-10-17","Statement":["x"]}')
      await put("effect number", doc({ ...allow("s3:GetObject", arn(b, "/*")), Effect: 1 }))
      await put("principal number", doc({ ...allow("s3:GetObject", arn(b, "/*")), Principal: 5 }))
      await put("action number", doc(allow("s3:GetObject", arn(b, "/*"), { Action: 7 })))
      await put("leading whitespace", ` \n\t${doc(allow("s3:GetObject", arn(b, "/*")))}`)
      await put("whitespace only", "   ")
      await put("bad escape", '{"Version":"2012-10-17","Statement":[{"Sid":"\\q"}]}')
      await put("unquoted key", '{Version:"2012-10-17"}')
      await put("missing colon", '{"Version" "2012-10-17"}')
      await put("missing comma", '{"Version":"2012-10-17" "Statement":[]}')
      await put("array missing comma", '{"Version":"2012-10-17","Statement":[{} {}]}')
      await put("bad literal", '{"Version":tru}')
      await put(
        "sid differs only",
        doc(
          { ...allow("s3:GetObject", arn(b, "/*")), Sid: "one" },
          { ...allow("s3:GetObject", arn(b, "/*")), Sid: "two" },
        ),
      )
      await s.req("get sid differs only", {
        method: "GET",
        path: keyPath(b),
        query: { policy: "" },
      })
      await put("empty object", "{}")
      await put(
        "unknown field",
        JSON.stringify({
          Version: "2012-10-17",
          Foo: 1,
          Statement: [allow("s3:GetObject", arn(b, "/*"))],
        }),
      )
      await put("bad effect", doc({ ...allow("s3:GetObject", arn(b, "/*")), Effect: "Maybe" }))
      await put(
        "lowercase effect",
        doc({ ...allow("s3:GetObject", arn(b, "/*")), Effect: "allow" }),
      )
      await put(
        "principal string",
        doc({ ...allow("s3:GetObject", arn(b, "/*")), Principal: "someone" }),
      )
      await put(
        "principal empty aws",
        doc({ ...allow("s3:GetObject", arn(b, "/*")), Principal: { AWS: [] } }),
      )
      await put(
        "principal missing",
        doc({ Effect: "Allow", Action: "s3:GetObject", Resource: arn(b, "/*") }),
      )
      await put(
        "principal user",
        doc({
          ...allow("s3:GetObject", arn(b, "/*")),
          Principal: { AWS: ["arn:aws:iam::123:user/x"] },
        }),
      )
      await put("action missing", doc({ Effect: "Allow", Principal: "*", Resource: arn(b, "/*") }))
      await put("action empty", doc(allow([], arn(b, "/*"))))
      await put("action unknown", doc(allow("s3:Frobnicate", arn(b, "/*"))))
      await put("action non s3", doc(allow("iam:CreateUser", arn(b, "/*"))))
      await put(
        "resource missing",
        doc({ Effect: "Allow", Principal: "*", Action: "s3:GetObject" }),
      )
      await put("resource empty", doc(allow("s3:GetObject", [])))
      await put("resource other bucket", doc(allow("s3:GetObject", arn("someone-else", "/*"))))
      await put("resource bad prefix", doc(allow("s3:GetObject", `bucket/${b}/*`)))
      await put("resource leading slash", doc(allow("s3:GetObject", arn(`/${b}`, "/*"))))
      await put("resource kms", doc(allow("s3:GetObject", "arn:minio:kms:::key")))
      await put("resource duplicate", doc(allow("s3:GetObject", [arn(b, "/*"), arn(b, "/*")])))
      await put("object action on bucket", doc(allow("s3:GetObject", arn(b))))
      await put("bucket action on object", doc(allow("s3:ListBucket", arn(b, "/*"))))
      await put(
        "condition bad key",
        doc(
          allow("s3:GetObject", arn(b, "/*"), { Condition: { StringEquals: { "s3:nope": "x" } } }),
        ),
      )
      await put(
        "condition unsupported key",
        doc(
          allow("s3:GetObject", arn(b, "/*"), {
            Condition: { StringEquals: { "s3:prefix": "x" } },
          }),
        ),
      )
      await put(
        "condition bad operator",
        doc(
          allow("s3:GetObject", arn(b, "/*"), {
            Condition: { StringSorta: { "aws:Referer": "x" } },
          }),
        ),
      )
      await put("condition empty", doc(allow("s3:GetObject", arn(b, "/*"), { Condition: {} })))
      await put(
        "condition bad ip",
        doc(
          allow("s3:GetObject", arn(b, "/*"), {
            Condition: { IpAddress: { "aws:SourceIp": "nope" } },
          }),
        ),
      )
      await put(
        "not action and action",
        doc({ ...allow("s3:GetObject", arn(b, "/*")), NotAction: "s3:PutObject" }),
      )
      await put(
        "not resource and resource",
        doc({ ...allow("s3:GetObject", arn(b, "/*")), NotResource: arn(b, "/x") }),
      )
      await put(
        "too large",
        doc(allow("s3:GetObject", arn(b, "/*"), { Sid: "x".repeat(21 * 1024) })),
      )
      await s.req("empty body", {
        method: "PUT",
        path: keyPath(b),
        query: { policy: "" },
        body: "",
      })
      await s.req("get after failures", { method: "GET", path: keyPath(b), query: { policy: "" } })
    },
  },
  {
    name: "anonymous-without-policy",
    async run(s) {
      const b = await s.bucket("pol-anon")
      await s.raw({ method: "PUT", path: keyPath(b, "k"), body: "hello" })
      await s.req("get object", anon("GET", keyPath(b, "k")))
      await s.req("head object", anon("HEAD", keyPath(b, "k")))
      await s.req("get missing", anon("GET", keyPath(b, "missing")))
      await s.req("put object", anon("PUT", keyPath(b, "new"), { body: "x" }))
      await s.req("delete object", anon("DELETE", keyPath(b, "k")))
      await s.req("list v1", anon("GET", keyPath(b)))
      await s.req("list v2", anon("GET", keyPath(b), { query: { "list-type": "2" } }))
      await s.req("head bucket", anon("HEAD", keyPath(b)))
      await s.req("location", anon("GET", keyPath(b), { query: { location: "" } }))
      await s.req("get policy", anon("GET", keyPath(b), { query: { policy: "" } }))
      await s.req("policy status", anon("GET", keyPath(b), { query: { policyStatus: "" } }))
      await s.req(
        "put policy",
        anon("PUT", keyPath(b), { query: { policy: "" }, body: doc(allow("s3:*", arn(b, "*"))) }),
      )
      await s.req("list buckets", anon("GET", "/"))
      await s.req("create bucket", anon("PUT", keyPath(s.name("pol-anon-new"))))
      await s.req("delete bucket", anon("DELETE", keyPath(b)))
      await s.req("get tagging", anon("GET", keyPath(b, "k"), { query: { tagging: "" } }))
      await s.req("get bucket tagging", anon("GET", keyPath(b), { query: { tagging: "" } }))
      await s.req("versioning", anon("GET", keyPath(b), { query: { versioning: "" } }))
    },
  },
  {
    name: "anonymous-missing-bucket",
    async run(s) {
      const b = s.name("pol-anon-gone")
      await s.req("get object", anon("GET", keyPath(b, "k")))
      await s.req("head object", anon("HEAD", keyPath(b, "k")))
      await s.req("put object", anon("PUT", keyPath(b, "k"), { body: "x" }))
      await s.req("list", anon("GET", keyPath(b)))
      await s.req("head bucket", anon("HEAD", keyPath(b)))
      await s.req("get policy", anon("GET", keyPath(b), { query: { policy: "" } }))
      await s.req(
        "put bucket tagging",
        anon("PUT", keyPath(b), {
          query: { tagging: "" },
          body: "<Tagging><TagSet></TagSet></Tagging>",
        }),
      )
      await s.req("get bucket tagging", anon("GET", keyPath(b), { query: { tagging: "" } }))
      await s.req("location", anon("GET", keyPath(b), { query: { location: "" } }))
    },
  },
  {
    name: "anonymous-public-read",
    async run(s) {
      const b = await s.bucket("pol-read")
      await s.raw({
        method: "PUT",
        path: keyPath(b, "k"),
        body: "hello",
        headers: { "content-type": "text/plain" },
      })
      await s.raw({ method: "PUT", path: keyPath(b, "dir/ü ñ.txt"), body: "unicode" })
      await setPolicy(s, b, doc(allow("s3:GetObject", arn(b, "/*"))))
      await s.req("get", anon("GET", keyPath(b, "k")))
      await s.req("head", anon("HEAD", keyPath(b, "k")))
      await s.req("range", anon("GET", keyPath(b, "k"), { headers: { range: "bytes=1-2" } }))
      await s.req("unicode", anon("GET", keyPath(b, "dir/ü ñ.txt")))
      // Without s3:ListBucket a missing key is AccessDenied, not NoSuchKey.
      await s.req("get missing", anon("GET", keyPath(b, "missing")))
      await s.req("head missing", anon("HEAD", keyPath(b, "missing")))
      await s.req("list", anon("GET", keyPath(b)))
      await s.req("put", anon("PUT", keyPath(b, "k"), { body: "overwrite" }))
      await s.req("delete", anon("DELETE", keyPath(b, "k")))
      await s.req("get tagging", anon("GET", keyPath(b, "k"), { query: { tagging: "" } }))
      await s.req("get acl", anon("GET", keyPath(b, "k"), { query: { acl: "" } }))
      await s.req("head bucket", anon("HEAD", keyPath(b)))
      await s.req("status owner", { method: "GET", path: keyPath(b), query: { policyStatus: "" } })
      // With s3:ListBucket too, a missing key is NoSuchKey.
      await setPolicy(
        s,
        b,
        doc(allow("s3:GetObject", arn(b, "/*")), allow("s3:ListBucket", arn(b))),
      )
      await s.req("get missing listable", anon("GET", keyPath(b, "missing")))
      await s.req("head missing listable", anon("HEAD", keyPath(b, "missing")))
      await s.req("list listable", anon("GET", keyPath(b)))
      await s.req("list v2 listable", anon("GET", keyPath(b), { query: { "list-type": "2" } }))
      await s.req("versions listable", anon("GET", keyPath(b), { query: { versions: "" } }))
      await s.req("head bucket listable", anon("HEAD", keyPath(b)))
      await s.req("uploads listable", anon("GET", keyPath(b), { query: { uploads: "" } }))
    },
  },
  {
    name: "anonymous-prefix-scoped",
    async run(s) {
      const b = await s.bucket("pol-prefix")
      await s.raw({ method: "PUT", path: keyPath(b, "public/a"), body: "a" })
      await s.raw({ method: "PUT", path: keyPath(b, "private/b"), body: "b" })
      await setPolicy(
        s,
        b,
        doc(
          allow("s3:GetObject", arn(b, "/public/*")),
          allow("s3:ListBucket", arn(b), {
            Condition: { StringEquals: { "s3:prefix": ["public/", "public"] } },
          }),
        ),
      )
      await s.req("get public", anon("GET", keyPath(b, "public/a")))
      await s.req("get private", anon("GET", keyPath(b, "private/b")))
      await s.req("list no prefix", anon("GET", keyPath(b)))
      await s.req("list public prefix", anon("GET", keyPath(b), { query: { prefix: "public/" } }))
      await s.req(
        "list public v2",
        anon("GET", keyPath(b), { query: { "list-type": "2", prefix: "public" } }),
      )
      await s.req("list private prefix", anon("GET", keyPath(b), { query: { prefix: "private/" } }))
      await setPolicy(
        s,
        b,
        doc(allow("s3:ListBucket", arn(b), { Condition: { StringLike: { "s3:prefix": "pub*" } } })),
      )
      await s.req("like public", anon("GET", keyPath(b), { query: { prefix: "public/" } }))
      await s.req("like private", anon("GET", keyPath(b), { query: { prefix: "private/" } }))
      await s.req("like none", anon("GET", keyPath(b)))
      await setPolicy(
        s,
        b,
        doc(
          allow("s3:ListBucket", arn(b), {
            Condition: { StringNotEquals: { "s3:prefix": "private/" } },
          }),
        ),
      )
      await s.req("not equals public", anon("GET", keyPath(b), { query: { prefix: "public/" } }))
      await s.req("not equals private", anon("GET", keyPath(b), { query: { prefix: "private/" } }))
      await s.req("not equals none", anon("GET", keyPath(b)))
      await setPolicy(
        s,
        b,
        doc(
          allow("s3:ListBucket", arn(b), { Condition: { StringEquals: { "s3:delimiter": "/" } } }),
        ),
      )
      await s.req("delimiter slash", anon("GET", keyPath(b), { query: { delimiter: "/" } }))
      await s.req("delimiter none", anon("GET", keyPath(b)))
      await setPolicy(
        s,
        b,
        doc(
          allow("s3:ListBucket", arn(b), {
            Condition: { NumericLessThanEquals: { "s3:max-keys": "5" } },
          }),
        ),
      )
      await s.req("max-keys 5", anon("GET", keyPath(b), { query: { "max-keys": "5" } }))
      await s.req("max-keys 50", anon("GET", keyPath(b), { query: { "max-keys": "50" } }))
      await s.req("max-keys none", anon("GET", keyPath(b)))
    },
  },
  {
    name: "anonymous-deny-overrides",
    async run(s) {
      const b = await s.bucket("pol-deny")
      await s.raw({ method: "PUT", path: keyPath(b, "open/a"), body: "a" })
      await s.raw({ method: "PUT", path: keyPath(b, "secret/b"), body: "b" })
      await setPolicy(
        s,
        b,
        doc(
          allow(["s3:GetObject", "s3:ListBucket"], [arn(b), arn(b, "/*")]),
          deny("s3:GetObject", arn(b, "/secret/*")),
        ),
      )
      await s.req("get open", anon("GET", keyPath(b, "open/a")))
      await s.req("get secret", anon("GET", keyPath(b, "secret/b")))
      await s.req("get secret missing", anon("GET", keyPath(b, "secret/none")))
      await s.req("list", anon("GET", keyPath(b)))
      // A Deny statement binds the owner? No: IAM decides for signed requests.
      await s.req("owner get secret", { method: "GET", path: keyPath(b, "secret/b") })
      await setPolicy(
        s,
        b,
        doc(
          allow("s3:*", arn(b, "*")),
          deny("s3:*", arn(b, "*"), {
            Condition: { StringLike: { "aws:UserAgent": "*blocked*" } },
          }),
        ),
      )
      await s.req(
        "ua allowed",
        anon("GET", keyPath(b, "open/a"), { headers: { "user-agent": "fine/1.0" } }),
      )
      await s.req(
        "ua blocked",
        anon("GET", keyPath(b, "open/a"), { headers: { "user-agent": "blocked/1.0" } }),
      )
      await setPolicy(
        s,
        b,
        doc(
          allow("s3:GetObject", arn(b, "/*"), {
            Condition: { StringEquals: { "aws:Referer": "https://site.test/" } },
          }),
        ),
      )
      await s.req(
        "referer match",
        anon("GET", keyPath(b, "open/a"), { headers: { referer: "https://site.test/" } }),
      )
      await s.req(
        "referer other",
        anon("GET", keyPath(b, "open/a"), { headers: { referer: "https://evil.test/" } }),
      )
      await s.req("referer none", anon("GET", keyPath(b, "open/a")))
    },
  },
  {
    name: "anonymous-write",
    async run(s) {
      const b = await s.bucket("pol-write")
      await setPolicy(s, b, doc(allow("s3:PutObject", arn(b, "/uploads/*"))))
      await s.req(
        "put allowed",
        anon("PUT", keyPath(b, "uploads/a.txt"), {
          body: "hello",
          headers: { "content-type": "text/plain" },
        }),
      )
      await s.req("put outside", anon("PUT", keyPath(b, "other/a.txt"), { body: "hello" }))
      await s.req("get own upload", anon("GET", keyPath(b, "uploads/a.txt")))
      await s.req("owner reads", { method: "GET", path: keyPath(b, "uploads/a.txt") })
      await s.req(
        "multipart create",
        anon("POST", keyPath(b, "uploads/mp"), { query: { uploads: "" } }),
      )
      await s.req("delete denied", anon("DELETE", keyPath(b, "uploads/a.txt")))
      await setPolicy(s, b, doc(allow(["s3:PutObject", "s3:DeleteObject"], arn(b, "/uploads/*"))))
      await s.req("delete allowed", anon("DELETE", keyPath(b, "uploads/a.txt")))
      await s.req("delete missing allowed", anon("DELETE", keyPath(b, "uploads/never")))
      await s.req("owner get deleted", { method: "GET", path: keyPath(b, "uploads/a.txt") })
    },
  },
  {
    name: "anonymous-wildcards",
    async run(s) {
      const b = await s.bucket("pol-wild")
      await s.raw({ method: "PUT", path: keyPath(b, "a/b/c.txt"), body: "c" })
      await s.raw({ method: "PUT", path: keyPath(b, "a/x.png"), body: "x" })
      await setPolicy(s, b, doc(allow("s3:Get*", arn(b, "/a/*.txt"))))
      await s.req("get star match", anon("GET", keyPath(b, "a/b/c.txt")))
      await s.req("get star miss", anon("GET", keyPath(b, "a/x.png")))
      await s.req(
        "tagging via Get*",
        anon("GET", keyPath(b, "a/b/c.txt"), { query: { tagging: "" } }),
      )
      await setPolicy(s, b, doc(allow("s3:GetObject", arn(b, "/a/?.png"))))
      await s.req("question match", anon("GET", keyPath(b, "a/x.png")))
      await setPolicy(s, b, doc(allow("s3:*", "arn:aws:s3:::*")))
      await s.req("all get", anon("GET", keyPath(b, "a/x.png")))
      await s.req("all list", anon("GET", keyPath(b), { query: { "list-type": "2" } }))
      await s.req("all put", anon("PUT", keyPath(b, "new"), { body: "n" }))
      await s.req("all get policy", anon("GET", keyPath(b), { query: { policy: "" } }))
      await s.req("all status", anon("GET", keyPath(b), { query: { policyStatus: "" } }))
      await s.req("all location", anon("GET", keyPath(b), { query: { location: "" } }))
      await s.req("all versioning", anon("GET", keyPath(b), { query: { versioning: "" } }))
      await s.req("all head bucket", anon("HEAD", keyPath(b)))
      await s.req("all delete policy", anon("DELETE", keyPath(b), { query: { policy: "" } }))
      await s.req("after delete", anon("GET", keyPath(b, "a/x.png")))
    },
  },
  {
    name: "anonymous-not-action",
    async run(s) {
      const b = await s.bucket("pol-not")
      await s.raw({ method: "PUT", path: keyPath(b, "a"), body: "a" })
      await s.raw({ method: "PUT", path: keyPath(b, "keep/b"), body: "b" })
      await s.req(
        "put not action",
        putPolicy(
          b,
          doc({
            Effect: "Allow",
            Principal: "*",
            NotAction: "s3:DeleteObject",
            Resource: arn(b, "/*"),
          }),
        ),
      )
      await s.req(
        "put not resource",
        putPolicy(
          b,
          doc({
            Effect: "Allow",
            Principal: "*",
            Action: "s3:GetObject",
            NotResource: arn(b, "/keep/*"),
          }),
        ),
      )
      await s.req("get policy", { method: "GET", path: keyPath(b), query: { policy: "" } })
      await s.req("get a", anon("GET", keyPath(b, "a")))
      await s.req("get keep", anon("GET", keyPath(b, "keep/b")))
      await setPolicy(
        s,
        b,
        doc(allow("s3:GetObject", arn(b, "/*")), {
          Effect: "Deny",
          Principal: "*",
          Action: "s3:GetObject",
          NotResource: arn(b, "/a"),
        }),
      )
      await s.req("deny not resource a", anon("GET", keyPath(b, "a")))
      await s.req("deny not resource keep", anon("GET", keyPath(b, "keep/b")))
    },
  },
  {
    name: "anonymous-bucket-subresources",
    async run(s) {
      const b = await s.bucket("pol-sub")
      await s.raw({ method: "PUT", path: keyPath(b, "k"), body: "k" })
      await setPolicy(
        s,
        b,
        doc(
          allow(
            [
              "s3:GetBucketPolicy",
              "s3:GetBucketLocation",
              "s3:GetBucketTagging",
              "s3:PutBucketTagging",
              "s3:GetBucketVersioning",
            ],
            arn(b),
          ),
          allow(
            ["s3:GetObjectTagging", "s3:PutObjectTagging", "s3:DeleteObjectTagging"],
            arn(b, "/*"),
          ),
        ),
      )
      // Several actions in one statement come back in Go map order: record the status only.
      const policy = await s.raw(anon("GET", keyPath(b), { query: { policy: "" } }))
      s.record("get policy", {
        status: policy.status,
        statements: (policy.text.match(/"Effect"/g) ?? []).length,
      })
      await s.req("location", anon("GET", keyPath(b), { query: { location: "" } }))
      await s.req("versioning", anon("GET", keyPath(b), { query: { versioning: "" } }))
      await s.req(
        "put bucket tagging",
        anon("PUT", keyPath(b), {
          query: { tagging: "" },
          body: "<Tagging><TagSet><Tag><Key>a</Key><Value>1</Value></Tag></TagSet></Tagging>",
        }),
      )
      await s.req("get bucket tagging", anon("GET", keyPath(b), { query: { tagging: "" } }))
      await s.req("delete bucket tagging", anon("DELETE", keyPath(b), { query: { tagging: "" } }))
      await s.req(
        "put object tagging",
        anon("PUT", keyPath(b, "k"), {
          query: { tagging: "" },
          body: "<Tagging><TagSet><Tag><Key>t</Key><Value>v</Value></Tag></TagSet></Tagging>",
        }),
      )
      await s.req("get object tagging", anon("GET", keyPath(b, "k"), { query: { tagging: "" } }))
      await s.req(
        "get missing tagging",
        anon("GET", keyPath(b, "missing"), { query: { tagging: "" } }),
      )
      await s.req(
        "delete object tagging",
        anon("DELETE", keyPath(b, "k"), { query: { tagging: "" } }),
      )
      await s.req("bucket acl (GetBucketPolicy)", anon("GET", keyPath(b), { query: { acl: "" } }))
      await s.req(
        "object acl (GetBucketPolicy)",
        anon("GET", keyPath(b, "k"), { query: { acl: "" } }),
      )
      await s.req("website (GetBucketPolicy)", anon("GET", keyPath(b), { query: { website: "" } }))
      await s.req("accelerate", anon("GET", keyPath(b), { query: { accelerate: "" } }))
      await s.req("cors", anon("GET", keyPath(b), { query: { cors: "" } }))
      await s.req(
        "put policy denied",
        anon("PUT", keyPath(b), { query: { policy: "" }, body: doc(allow("s3:*", arn(b, "*"))) }),
      )
      await s.req("lifecycle denied", anon("GET", keyPath(b), { query: { lifecycle: "" } }))
      await s.req("status denied", anon("GET", keyPath(b), { query: { policyStatus: "" } }))
      await s.req("status denied head", anon("HEAD", keyPath(b), { query: { policyStatus: "" } }))
    },
  },
  {
    name: "anonymous-versioned",
    async run(s) {
      const b = await s.bucket("pol-ver", { versioning: "Enabled" })
      const first = await s.raw({ method: "PUT", path: keyPath(b, "k"), body: "one" })
      await s.raw({ method: "PUT", path: keyPath(b, "k"), body: "two" })
      const v1 = first.headers.get("x-amz-version-id") ?? ""
      await setPolicy(s, b, doc(allow("s3:GetObject", arn(b, "/*"))))
      await s.req("get latest", anon("GET", keyPath(b, "k")))
      await s.req("get version", anon("GET", keyPath(b, "k"), { query: { versionId: v1 } }))
      await setPolicy(s, b, doc(allow("s3:GetObjectVersion", arn(b, "/*"))))
      await s.req("get via GetObjectVersion", anon("GET", keyPath(b, "k")))
      await s.req(
        "get version via GetObjectVersion",
        anon("GET", keyPath(b, "k"), { query: { versionId: v1 } }),
      )
      await setPolicy(s, b, doc(allow("s3:ListBucket", arn(b))))
      await s.req("versions via ListBucket", anon("GET", keyPath(b), { query: { versions: "" } }))
      await setPolicy(s, b, doc(allow("s3:ListBucketVersions", arn(b))))
      await s.req(
        "versions via ListBucketVersions",
        anon("GET", keyPath(b), { query: { versions: "" } }),
      )
      await s.req("list via ListBucketVersions", anon("GET", keyPath(b)))
    },
  },
  {
    name: "anonymous-conditions",
    async run(s) {
      const b = await s.bucket("pol-cond")
      await s.raw({
        method: "PUT",
        path: keyPath(b, "k"),
        body: "k",
        headers: { "x-amz-tagging": "class=public" },
      })
      await s.raw({
        method: "PUT",
        path: keyPath(b, "hidden"),
        body: "h",
        headers: { "x-amz-tagging": "class=private" },
      })
      await s.raw({ method: "PUT", path: keyPath(b, "untagged"), body: "u" })
      await setPolicy(
        s,
        b,
        doc(
          allow("s3:GetObject", arn(b, "/*"), {
            Condition: { IpAddress: { "aws:SourceIp": "127.0.0.0/8" } },
          }),
        ),
      )
      await s.req("ip loopback", anon("GET", keyPath(b, "k")))
      await s.req(
        "ip forwarded outside",
        anon("GET", keyPath(b, "k"), { headers: { "x-forwarded-for": "10.1.2.3" } }),
      )
      await s.req(
        "ip forwarded inside",
        anon("GET", keyPath(b, "k"), { headers: { "x-forwarded-for": "127.9.9.9, 10.0.0.1" } }),
      )
      await s.req(
        "ip real-ip outside",
        anon("GET", keyPath(b, "k"), { headers: { "x-real-ip": "192.168.1.1" } }),
      )
      await setPolicy(
        s,
        b,
        doc(
          allow("s3:GetObject", arn(b, "/*"), {
            Condition: { NotIpAddress: { "aws:SourceIp": ["10.0.0.0/8", "192.168.0.0/16"] } },
          }),
        ),
      )
      await s.req("not ip loopback", anon("GET", keyPath(b, "k")))
      await s.req(
        "not ip forwarded 10",
        anon("GET", keyPath(b, "k"), { headers: { "x-forwarded-for": "10.1.2.3" } }),
      )
      await setPolicy(
        s,
        b,
        doc(
          allow("s3:GetObject", arn(b, "/*"), {
            Condition: { StringEquals: { "s3:ExistingObjectTag/class": "public" } },
          }),
        ),
      )
      await s.req("tag public", anon("GET", keyPath(b, "k")))
      await s.req("tag private", anon("GET", keyPath(b, "hidden")))
      await s.req("tag none", anon("GET", keyPath(b, "untagged")))
      await s.req("tag head public", anon("HEAD", keyPath(b, "k")))
      await s.req("tag missing key", anon("GET", keyPath(b, "nope")))
      await setPolicy(
        s,
        b,
        doc(
          allow("s3:PutObject", arn(b, "/*"), {
            Condition: { StringEquals: { "s3:RequestObjectTag/team": "a" } },
          }),
        ),
      )
      await s.req(
        "put with tag",
        anon("PUT", keyPath(b, "new1"), { body: "n", headers: { "x-amz-tagging": "team=a" } }),
      )
      await s.req(
        "put wrong tag",
        anon("PUT", keyPath(b, "new2"), { body: "n", headers: { "x-amz-tagging": "team=b" } }),
      )
      await s.req("put no tag", anon("PUT", keyPath(b, "new3"), { body: "n" }))
      await setPolicy(
        s,
        b,
        doc(
          allow("s3:GetObject", arn(b, "/*"), { Condition: { Null: { "aws:Referer": "false" } } }),
        ),
      )
      await s.req(
        "null referer present",
        anon("GET", keyPath(b, "k"), { headers: { referer: "x" } }),
      )
      await s.req("null referer absent", anon("GET", keyPath(b, "k")))
      await setPolicy(
        s,
        b,
        doc(
          allow("s3:GetObject", arn(b, "/*"), {
            Condition: { StringEqualsIgnoreCase: { "aws:UserAgent": "SPECIAL-AGENT" } },
          }),
        ),
      )
      await s.req(
        "ignore case match",
        anon("GET", keyPath(b, "k"), { headers: { "user-agent": "special-agent" } }),
      )
      await s.req(
        "ignore case miss",
        anon("GET", keyPath(b, "k"), { headers: { "user-agent": "other" } }),
      )
      await setPolicy(
        s,
        b,
        doc(
          allow("s3:GetObject", arn(b, "/*"), {
            Condition: { "ForAnyValue:StringLike": { "aws:UserAgent": ["curl/*", "wget*"] } },
          }),
        ),
      )
      await s.req(
        "any value match",
        anon("GET", keyPath(b, "k"), { headers: { "user-agent": "curl/8.0" } }),
      )
      await s.req(
        "any value miss",
        anon("GET", keyPath(b, "k"), { headers: { "user-agent": "bun" } }),
      )
      await setPolicy(
        s,
        b,
        doc(
          allow("s3:GetObject", arn(b, "/*"), {
            Condition: { Bool: { "aws:SecureTransport": "true" } },
          }),
        ),
      )
      await s.req("secure transport required", anon("GET", keyPath(b, "k")))
      await setPolicy(
        s,
        b,
        doc(
          allow("s3:GetObject", arn(b, "/*"), {
            Condition: { DateGreaterThan: { "aws:CurrentTime": "2001-01-01T00:00:00Z" } },
          }),
        ),
      )
      await s.req("date after 2001", anon("GET", keyPath(b, "k")))
      await setPolicy(
        s,
        b,
        doc(
          allow("s3:GetObject", arn(b, "/*"), {
            Condition: { DateLessThan: { "aws:CurrentTime": "2001-01-01T00:00:00Z" } },
          }),
        ),
      )
      await s.req("date before 2001", anon("GET", keyPath(b, "k")))
      await setPolicy(
        s,
        b,
        doc(
          allow("s3:GetObject", arn(b, "/*"), {
            Condition: { StringEquals: { "aws:principaltype": "Anonymous" } },
          }),
        ),
      )
      await s.req("principal type anonymous", anon("GET", keyPath(b, "k")))
    },
  },
  {
    name: "anonymous-principals",
    async run(s) {
      const b = await s.bucket("pol-princ")
      await s.raw({ method: "PUT", path: keyPath(b, "k"), body: "k" })
      await setPolicy(
        s,
        b,
        doc({
          ...allow("s3:GetObject", arn(b, "/*")),
          Principal: { AWS: ["arn:aws:iam::123456789012:user/alice"] },
        }),
      )
      await s.req("user principal", anon("GET", keyPath(b, "k")))
      await setPolicy(
        s,
        b,
        doc({ ...allow("s3:GetObject", arn(b, "/*")), Principal: { AWS: "*" } }),
      )
      await s.req("aws string star", anon("GET", keyPath(b, "k")))
      await setPolicy(
        s,
        b,
        doc({ ...allow("s3:GetObject", arn(b, "/*")), Principal: { AWS: ["a*"] } }),
      )
      await s.req("prefix principal", anon("GET", keyPath(b, "k")))
      // biome-ignore lint/suspicious/noTemplateCurlyInString: a policy variable, not a template
      await setPolicy(s, b, doc(allow("s3:GetObject", arn(b, "/${aws:username}/*"))))
      await s.req("variable resource", anon("GET", keyPath(b, "k")))
    },
  },
  {
    name: "anonymous-copy-and-batch",
    async run(s) {
      const b = await s.bucket("pol-copy")
      await s.raw({ method: "PUT", path: keyPath(b, "src/a"), body: "a" })
      await s.raw({ method: "PUT", path: keyPath(b, "src/b"), body: "b" })
      await setPolicy(s, b, doc(allow("s3:PutObject", arn(b, "/dst/*"))))
      await s.req(
        "copy without read",
        anon("PUT", keyPath(b, "dst/a"), { headers: { "x-amz-copy-source": `/${b}/src/a` } }),
      )
      await setPolicy(
        s,
        b,
        doc(allow("s3:PutObject", arn(b, "/dst/*")), allow("s3:GetObject", arn(b, "/src/*"))),
      )
      await s.req(
        "copy allowed",
        anon("PUT", keyPath(b, "dst/a"), { headers: { "x-amz-copy-source": `/${b}/src/a` } }),
      )
      await s.req(
        "copy to forbidden dst",
        anon("PUT", keyPath(b, "other/a"), { headers: { "x-amz-copy-source": `/${b}/src/a` } }),
      )
      // DeleteObjects authorizes each key (MinIO answers per-key AccessDenied entries); the
      // emulator refuses an anonymous DeleteObjects outright, so it is not pinned here.
      await setPolicy(
        s,
        b,
        doc(
          allow(
            ["s3:PutObject", "s3:ListMultipartUploadParts", "s3:AbortMultipartUpload"],
            arn(b, "/mp/*"),
          ),
          allow("s3:ListBucketMultipartUploads", arn(b)),
        ),
      )
      const created = await s.req(
        "multipart create",
        anon("POST", keyPath(b, "mp/x"), { query: { uploads: "" } }),
      )
      const uploadId = created.tag("UploadId") ?? ""
      await s.req(
        "upload part",
        anon("PUT", keyPath(b, "mp/x"), { query: { partNumber: "1", uploadId }, body: "part" }),
      )
      await s.req("list parts", anon("GET", keyPath(b, "mp/x"), { query: { uploadId } }))
      await s.req("list uploads", anon("GET", keyPath(b), { query: { uploads: "" } }))
      await s.req("abort", anon("DELETE", keyPath(b, "mp/x"), { query: { uploadId } }))
    },
  },
]
