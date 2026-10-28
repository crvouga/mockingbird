/**
 * config/: MinIO's dummy bucket sub-resources (website, accelerate, requestPayment, logging, CORS
 * without a configuration), every NotImplemented route of `api-router.go`, and the
 * ListenNotification argument checks. Bucket CORS writes follow AWS in the emulator and are
 * deliberately not here (MinIO answers NotImplemented).
 */
import { keyPath, type RequestSpec, type Scenario } from "../../harness.js"

const get = (
  path: string,
  query: Record<string, string>,
  extra: Partial<RequestSpec> = {},
): RequestSpec => ({
  method: "GET",
  path,
  query,
  ...extra,
})

export const scenarios: Scenario[] = [
  {
    name: "dummy-subresources",
    async run(s) {
      const b = await s.bucket("dummy")
      for (const name of ["website", "accelerate", "requestPayment", "logging", "cors"])
        await s.req(`get ${name}`, get(keyPath(b), { [name]: "" }))
      await s.req("delete website", { method: "DELETE", path: keyPath(b), query: { website: "" } })
      await s.req("head website", { method: "HEAD", path: keyPath(b), query: { website: "" } })
      await s.req("get website with value", get(keyPath(b), { website: "x" }))
    },
  },
  {
    name: "dummy-subresources-missing-bucket",
    async run(s) {
      const b = s.name("dummy-gone")
      for (const name of ["website", "accelerate", "requestPayment", "logging", "cors"])
        await s.req(`get ${name}`, get(keyPath(b), { [name]: "" }))
      await s.req("delete website", { method: "DELETE", path: keyPath(b), query: { website: "" } })
    },
  },
  {
    name: "dummy-subresources-anonymous",
    async run(s) {
      const b = await s.bucket("dummy-anon")
      for (const name of ["website", "accelerate", "requestPayment", "logging", "cors"])
        await s.req(`get ${name}`, get(keyPath(b), { [name]: "" }, { auth: "anonymous" }))
      await s.req("delete website", {
        method: "DELETE",
        path: keyPath(b),
        query: { website: "" },
        auth: "anonymous",
      })
      await s.req("delete website missing bucket", {
        method: "DELETE",
        path: keyPath(s.name("dummy-anon-gone")),
        query: { website: "" },
        auth: "anonymous",
      })
    },
  },
  {
    name: "not-implemented-object",
    async run(s) {
      const b = await s.bucket("notimpl-obj")
      await s.raw({ method: "PUT", path: keyPath(b, "k"), body: "k" })
      for (const method of ["GET", "PUT", "DELETE"])
        await s.req(`${method} torrent`, { method, path: keyPath(b, "k"), query: { torrent: "" } })
      await s.req("delete acl", { method: "DELETE", path: keyPath(b, "k"), query: { acl: "" } })
      await s.req("torrent missing key", {
        method: "GET",
        path: keyPath(b, "missing"),
        query: { torrent: "" },
      })
      await s.req("torrent missing bucket", {
        method: "GET",
        path: keyPath(s.name("notimpl-gone"), "k"),
        query: { torrent: "" },
      })
      await s.req("torrent anonymous", {
        method: "GET",
        path: keyPath(b, "k"),
        query: { torrent: "" },
        auth: "anonymous",
      })
      await s.req("head torrent", { method: "HEAD", path: keyPath(b, "k"), query: { torrent: "" } })
    },
  },
  {
    name: "not-implemented-bucket",
    async run(s) {
      const b = await s.bucket("notimpl")
      for (const name of [
        "inventory",
        "metrics",
        "publicAccessBlock",
        "ownershipControls",
        "intelligent-tiering",
        "analytics",
      ])
        await s.req(`GET ${name}`, get(keyPath(b), { [name]: "" }))
      await s.req("missing bucket", get(keyPath(s.name("notimpl-gone")), { inventory: "" }))
      await s.req("anonymous", get(keyPath(b), { analytics: "" }, { auth: "anonymous" }))
      await s.req("with id", get(keyPath(b), { metrics: "", id: "m1" }))
      await s.req("head acl", { method: "HEAD", path: keyPath(b), query: { acl: "" } })
    },
  },
  {
    // MinIO registers the bucket-level rejected PUT/DELETE routes after PutBucket/DeleteBucket,
    // so they are CreateBucket / DeleteBucket requests in disguise.
    name: "not-implemented-bucket-shadowed",
    async run(s) {
      const b = await s.bucket("notimpl-shadow")
      await s.raw({ method: "PUT", path: keyPath(b, "keep"), body: "k" })
      const routes: [string, string[]][] = [
        ["inventory", ["PUT", "DELETE"]],
        ["metrics", ["PUT", "DELETE"]],
        ["website", ["PUT"]],
        ["logging", ["PUT", "DELETE"]],
        ["accelerate", ["PUT", "DELETE"]],
        ["requestPayment", ["PUT", "DELETE"]],
        ["acl", ["DELETE"]],
        ["publicAccessBlock", ["PUT", "DELETE"]],
        ["ownershipControls", ["PUT", "DELETE"]],
        ["intelligent-tiering", ["PUT", "DELETE"]],
        ["analytics", ["PUT", "DELETE"]],
      ]
      for (const [name, methods] of routes)
        for (const method of methods)
          await s.req(`${method} ${name}`, { method, path: keyPath(b), query: { [name]: "" } })
    },
  },
  {
    name: "listen-notification-arguments",
    async run(s) {
      const b = await s.bucket("listen")
      await s.req("bad event", get(keyPath(b), { events: "s3:Nope" }))
      await s.req("empty event", get(keyPath(b), { events: "" }))
      await s.req("two prefixes", {
        method: "GET",
        path: keyPath(b),
        query: [
          ["events", "s3:ObjectCreated:*"],
          ["prefix", "a"],
          ["prefix", "b"],
        ],
      })
      await s.req("two suffixes", {
        method: "GET",
        path: keyPath(b),
        query: [
          ["events", "s3:ObjectCreated:*"],
          ["suffix", "a"],
          ["suffix", "b"],
        ],
      })
      await s.req("bad prefix", get(keyPath(b), { events: "s3:ObjectCreated:*", prefix: "a/../b" }))
      await s.req(
        "long prefix",
        get(keyPath(b), { events: "s3:ObjectCreated:*", prefix: "p".repeat(1025) }),
      )
      await s.req(
        "missing bucket",
        get(keyPath(s.name("listen-gone")), { events: "s3:ObjectCreated:*" }),
      )
      await s.req(
        "missing bucket bad event",
        get(keyPath(s.name("listen-gone")), { events: "bogus" }),
      )
      await s.req(
        "anonymous",
        get(keyPath(b), { events: "s3:ObjectCreated:*" }, { auth: "anonymous" }),
      )
      await s.req("root bad event", get("/", { events: "bogus" }))
      await s.req(
        "root anonymous",
        get("/", { events: "s3:ObjectCreated:*" }, { auth: "anonymous" }),
      )
    },
  },
]
