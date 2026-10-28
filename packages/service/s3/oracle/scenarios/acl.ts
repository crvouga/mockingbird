/**
 * ACLs: MinIO's dummies. GetBucketAcl/GetObjectAcl answer one fixed FULL_CONTROL grant;
 * PutBucketAcl/PutObjectAcl accept only the `private` canned ACL or a body whose first grant is
 * FULL_CONTROL, and answer NotImplemented otherwise.
 */
import { keyPath, type RequestSpec, type Scenario } from "../harness.js"

const acl = (permission: string, extra = "") =>
  `<AccessControlPolicy><Owner><ID>owner</ID></Owner><AccessControlList><Grant><Grantee xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:type="CanonicalUser"><ID>owner</ID></Grantee><Permission>${permission}</Permission></Grant>${extra}</AccessControlList></AccessControlPolicy>`

const puts = (path: string): [string, Partial<RequestSpec>][] =>
  [
    ["canned private", { headers: { "x-amz-acl": "private" } }],
    ["canned public-read", { headers: { "x-amz-acl": "public-read" } }],
    ["canned public-read-write", { headers: { "x-amz-acl": "public-read-write" } }],
    ["canned authenticated-read", { headers: { "x-amz-acl": "authenticated-read" } }],
    ["canned bogus", { headers: { "x-amz-acl": "bogus" } }],
    ["canned private with body", { headers: { "x-amz-acl": "private" }, body: acl("READ") }],
    ["body full control", { body: acl("FULL_CONTROL") }],
    [
      "body full control then read",
      {
        body: acl(
          "FULL_CONTROL",
          "<Grant><Grantee><URI>x</URI></Grantee><Permission>READ</Permission></Grant>",
        ),
      },
    ],
    ["body read", { body: acl("READ") }],
    ["body write", { body: acl("WRITE") }],
    [
      "body no grants",
      {
        body: "<AccessControlPolicy><AccessControlList></AccessControlList></AccessControlPolicy>",
      },
    ],
    ["body empty policy", { body: "<AccessControlPolicy/>" }],
    [
      "body wrong root",
      {
        body: "<Other><AccessControlList><Grant><Permission>FULL_CONTROL</Permission></Grant></AccessControlList></Other>",
      },
    ],
    ["body not xml", { body: "not xml" }],
    ["body truncated", { body: "<AccessControlPolicy><AccessControlList>" }],
    [
      "body namespaced",
      {
        body: `<?xml version="1.0" encoding="UTF-8"?><AccessControlPolicy xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><AccessControlList><Grant><Permission>FULL_CONTROL</Permission></Grant></AccessControlList></AccessControlPolicy>`,
      },
    ],
    [
      "grant header",
      { headers: { "x-amz-grant-read": "uri=http://acs.amazonaws.com/groups/global/AllUsers" } },
    ],
    ["empty body", { body: "" }],
  ].map(([step, spec]) => [
    step as string,
    { method: "PUT", path, query: { acl: "" }, ...(spec as object) },
  ])

export const scenarios: Scenario[] = [
  {
    name: "bucket-acl",
    async run(s) {
      const b = await s.bucket("acl")
      await s.req("get", { method: "GET", path: keyPath(b), query: { acl: "" } })
      for (const [step, spec] of puts(keyPath(b))) await s.req(step, spec as RequestSpec)
      await s.req("get after puts", { method: "GET", path: keyPath(b), query: { acl: "" } })
      await s.req("get with value", { method: "GET", path: keyPath(b), query: { acl: "x" } })
    },
  },
  {
    name: "bucket-acl-missing",
    async run(s) {
      const b = s.name("acl-gone")
      await s.req("get", { method: "GET", path: keyPath(b), query: { acl: "" } })
      await s.req("put private", {
        method: "PUT",
        path: keyPath(b),
        query: { acl: "" },
        headers: { "x-amz-acl": "private" },
      })
      await s.req("put bogus", {
        method: "PUT",
        path: keyPath(b),
        query: { acl: "" },
        headers: { "x-amz-acl": "bogus" },
      })
      await s.req("put bad body", {
        method: "PUT",
        path: keyPath(b),
        query: { acl: "" },
        body: "nope",
      })
    },
  },
  {
    name: "object-acl",
    async run(s) {
      const b = await s.bucket("oacl")
      await s.raw({ method: "PUT", path: keyPath(b, "k"), body: "k" })
      await s.req("get", { method: "GET", path: keyPath(b, "k"), query: { acl: "" } })
      for (const [step, spec] of puts(keyPath(b, "k"))) await s.req(step, spec as RequestSpec)
      await s.raw({ method: "PUT", path: keyPath(b, "dir/ü ñ"), body: "u" })
      await s.req("get unicode key", {
        method: "GET",
        path: keyPath(b, "dir/ü ñ"),
        query: { acl: "" },
      })
      await s.req("head", { method: "HEAD", path: keyPath(b, "k"), query: { acl: "" } })
    },
  },
  {
    name: "object-acl-missing",
    async run(s) {
      const b = await s.bucket("oacl-miss", { versioning: "Enabled" })
      await s.req("get missing key", {
        method: "GET",
        path: keyPath(b, "nope"),
        query: { acl: "" },
      })
      await s.req("put missing key", {
        method: "PUT",
        path: keyPath(b, "nope"),
        query: { acl: "" },
        headers: { "x-amz-acl": "private" },
      })
      await s.req("put bogus missing key", {
        method: "PUT",
        path: keyPath(b, "nope"),
        query: { acl: "" },
        headers: { "x-amz-acl": "bogus" },
      })
      const gone = s.name("oacl-gone")
      await s.req("get missing bucket", {
        method: "GET",
        path: keyPath(gone, "k"),
        query: { acl: "" },
      })
      await s.req("put missing bucket", {
        method: "PUT",
        path: keyPath(gone, "k"),
        query: { acl: "" },
        headers: { "x-amz-acl": "private" },
      })
      const put = await s.raw({ method: "PUT", path: keyPath(b, "k"), body: "k" })
      const v1 = put.headers.get("x-amz-version-id") ?? ""
      await s.raw({ method: "DELETE", path: keyPath(b, "k") })
      await s.req("get delete marker", { method: "GET", path: keyPath(b, "k"), query: { acl: "" } })
      await s.req("put delete marker", {
        method: "PUT",
        path: keyPath(b, "k"),
        query: { acl: "" },
        headers: { "x-amz-acl": "private" },
      })
      await s.req("get old version ignored", {
        method: "GET",
        path: keyPath(b, "k"),
        query: { acl: "", versionId: v1 },
      })
    },
  },
]
