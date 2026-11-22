import { expect, test } from "bun:test"
import { createRuntime } from "./src/index.js"

const headers = {
  "X-Open-Wearables-API-Key": "open_wearables_test",
  "content-type": "application/json",
}
test("public OAuth consent creates a connection only after one-time approval", async () => {
  const runtime = createRuntime()
  const user = await (
    await runtime.fetch(
      new Request("https://wearables.test/api/v1/users", {
        method: "POST",
        headers,
        body: JSON.stringify({ external_user_id: "fixture" }),
      }),
    )
  ).json()
  const auth = await runtime.fetch(
    new Request(
      `https://wearables.test/api/v1/oauth/garmin/authorize?user_id=${user.id}&redirect_uri=https%3A%2F%2Fapp.test%2Fdone`,
      { headers },
    ),
  )
  expect(auth.status).toBe(200)
  const { authorization_url, state } = await auth.json()
  expect(new URL(authorization_url).origin).toBe("https://wearables.test")
  expect(runtime.instance().state.connections.list()).toEqual([])
  expect(await (await runtime.fetch(new Request(authorization_url))).text()).toContain(
    "Allow connection",
  )
  const approve = () =>
    runtime.fetch(
      new Request(authorization_url, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "decision=allow",
      }),
    )
  const result = await approve()
  expect(result.status).toBe(303)
  expect(result.headers.get("location")).toBe("https://app.test/done")
  expect(runtime.instance().state.connections.list()[0]?.value).toMatchObject({
    user_id: user.id,
    provider: "garmin",
    status: "active",
  })
  expect((await approve()).status).toBe(409)
  expect(state).toBeTruthy()
})

test("pairing filters providers and invalid or cancelled consent cannot mutate connections", async () => {
  const runtime = createRuntime()
  const user = await (
    await runtime.fetch(
      new Request("https://wearables.test/api/v1/users", {
        method: "POST",
        headers,
        body: JSON.stringify({ external_user_id: "fixture" }),
      }),
    )
  ).json()
  const page = await runtime.fetch(new Request(`https://wearables.test/users/${user.id}/pair`))
  expect(page.status).toBe(200)
  const html = await page.text()
  expect(html).toContain("Garmin")
  expect(html).not.toContain("Apple Health")
  const bad = await runtime.fetch(
    new Request(
      `https://wearables.test/users/${user.id}/pair/garmin?redirect_url=javascript:alert(1)`,
    ),
  )
  expect(bad.status).toBe(422)
  const redirect = await runtime.fetch(
    new Request(`https://wearables.test/users/${user.id}/pair/garmin`),
  )
  expect(redirect.status).toBe(303)
  const url = redirect.headers.get("location") as string
  const denied = await runtime.fetch(
    new Request(url, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "decision=deny",
    }),
  )
  expect(denied.status).toBe(200)
  expect(await denied.text()).toContain("Connection cancelled")
  expect(runtime.instance().state.connections.list()).toEqual([])
  await runtime.reset()
  expect((await runtime.fetch(new Request(url))).status).toBe(404)
})

test("consent expiry and namespace isolation prevent unintended connections", async () => {
  const runtime = createRuntime()
  const namespaced = { ...headers, "x-mockingbird-namespace": "branch" }
  const user = await (
    await runtime.fetch(
      new Request("https://wearables.test/api/v1/users", {
        method: "POST",
        headers: namespaced,
        body: JSON.stringify({ external_user_id: "fixture" }),
      }),
    )
  ).json()
  const auth = await (
    await runtime.fetch(
      new Request(`https://wearables.test/api/v1/oauth/oura/authorize?user_id=${user.id}`, {
        headers: namespaced,
      }),
    )
  ).json()
  expect(auth.authorization_url).toContain("/__admin/ns/branch/")
  expect((await runtime.fetch(new Request(auth.authorization_url))).status).toBe(200)
  expect(runtime.instance().state.authorizations.list()).toEqual([])
  runtime.clock.advance(600000)
  expect(
    (
      await runtime.fetch(
        new Request(auth.authorization_url, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: "decision=allow",
        }),
      )
    ).status,
  ).toBe(409)
  expect(runtime.instance("branch").state.connections.list()).toEqual([])
})
