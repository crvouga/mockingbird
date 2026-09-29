import { expect, test } from "bun:test"
import { DockerAPI } from "./src/index.js"

test("GET and HEAD ping expose the pinned Engine API version", async () => {
  const api = new DockerAPI()
  for (const method of ["GET", "HEAD"]) {
    const response = await api.fetch(new Request("http://docker.local/_ping", { method }))
    expect(response.status).toBe(200)
    expect(response.headers.get("api-version")).toBe("1.52")
    expect(response.headers.get("docker-experimental")).toBe("false")
    expect(response.headers.get("builder-version")).toBe("2")
    expect(response.headers.get("swarm")).toBe("inactive")
    expect(await response.text()).toBe(method === "GET" ? "OK" : "")
  }
})

test("unimplemented lifecycle and Fetch attach fail explicitly; unknown routes are 404", async () => {
  const api = new DockerAPI()
  for (const path of ["/containers/example/attach"]) {
    const response = await api.fetch(new Request(`http://docker.local${path}`, { method: "POST" }))
    expect(response.status).toBe(501)
    expect(await response.json()).toEqual({ message: expect.stringContaining("not implemented") })
  }
  const missing = await api.fetch(new Request("http://docker.local/missing"))
  expect(missing.status).toBe(404)
  expect(await missing.json()).toEqual({ message: "page not found" })
})
