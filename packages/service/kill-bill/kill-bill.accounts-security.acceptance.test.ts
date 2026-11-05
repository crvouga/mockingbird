import { expect, test } from "bun:test"
import { KillBillAPI } from "./src/index.js"

const headers = {
  authorization: `Basic ${btoa("admin:password")}`,
  "content-type": "application/json",
  "x-killbill-apikey": "bob",
  "x-killbill-apisecret": "lazar",
  "x-killbill-createdby": "account-test",
}

test("permissions require configured Basic credentials and no tenant headers", async () => {
  const api = new KillBillAPI({ username: "test-admin", password: "test-password" })
  const call = (authorization?: string) =>
    api.fetch(
      new Request("http://localhost/1.0/kb/security/permissions", {
        headers: authorization ? { authorization } : {},
      }),
    )
  expect(await (await call(`Basic ${btoa("test-admin:test-password")}`)).json()).toEqual(["*:*"])
  for (const auth of [undefined, `Basic ${btoa("test-admin:incorrect")}`]) {
    const response = await call(auth)
    expect(response.status).toBe(401)
    expect(await response.json()).toMatchObject({ code: "UNAUTHORIZED" })
  }
})

test("account updates preserve omitted fields and reject invalid changes atomically", async () => {
  const api = new KillBillAPI()
  const call = (path: string, method = "GET", body?: unknown, customHeaders = headers) =>
    api.fetch(
      new Request(`http://localhost/1.0/kb${path}`, {
        method,
        headers: customHeaders,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    )
  const created = await call("/accounts", "POST", {
    currency: "USD",
    name: "Test Member",
    email: "before@example.test",
  })
  const path = new URL(created.headers.get("location") as string).pathname.replace("/1.0/kb", "")
  expect(
    (await call(path, "PUT", { name: "Updated Member", email: "after@example.test" })).status,
  ).toBe(204)
  expect(await (await call(path)).json()).toMatchObject({
    name: "Updated Member",
    email: "after@example.test",
  })
  expect((await call(path, "PUT", { email: "partial@example.test" })).status).toBe(204)
  expect(await (await call(path)).json()).toMatchObject({
    name: "Updated Member",
    email: "partial@example.test",
  })
  const before = await (await call(path)).json()
  for (const change of [
    { currency: "EUR", name: "Invalid" },
    { email: 42 },
    { tenantId: "other" },
    { billCycleDayLocal: 5 },
  ]) {
    expect((await call(path, "PUT", change)).status).toBe(400)
    expect(await (await call(path)).json()).toEqual(before)
  }
  expect((await call("/accounts/missing", "PUT", { name: "Unknown" })).status).toBe(404)
  expect((await call(path, "PUT", { email: null })).status).toBe(204)
  expect(await (await call(path)).json()).toMatchObject({ email: "partial@example.test" })
  expect((await call(`${path}?treatNullAsReset=true`, "PUT", { email: null })).status).toBe(204)
  expect(await (await call(path)).json()).toMatchObject({ email: null })
})
