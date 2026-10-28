import { keyPath, type Scenario } from "../harness.js"

export const scenarios: Scenario[] = [
  {
    name: "put-get-head-delete",
    async run(s) {
      const b = await s.bucket("basics")
      await s.req("put", {
        method: "PUT",
        path: keyPath(b, "a b/c.txt"),
        body: "hello",
        headers: { "content-type": "text/plain", "x-amz-meta-Color": "Blue" },
      })
      await s.req("get", { method: "GET", path: keyPath(b, "a b/c.txt") })
      await s.req("head", { method: "HEAD", path: keyPath(b, "a b/c.txt") })
      await s.req("get missing", { method: "GET", path: keyPath(b, "nope") })
      await s.req("head missing", { method: "HEAD", path: keyPath(b, "nope") })
      await s.req("delete", { method: "DELETE", path: keyPath(b, "a b/c.txt") })
      await s.req("get deleted", { method: "GET", path: keyPath(b, "a b/c.txt") })
    },
  },
]
