import { expect, test } from "bun:test"
import { createRuntime } from "./src/index.js"

test("AWS transport rejects unsupported operations and malformed JSON", async () => {
  const runtime = createRuntime()
  const call = (body: string) =>
    runtime.fetch(
      new Request("http://mock/", {
        method: "POST",
        headers: {
          "content-type": "application/x-amz-json-1.1",
          "x-amz-target": "Fixture.UnknownOperation",
        },
        body,
      }),
    )
  const unsupported = await call("{}")
  expect(unsupported.status).toBe(400)
  expect((await unsupported.json()).__type).toBe("UnknownOperationException")
  const malformed = await call("{")
  expect(malformed.status).toBe(400)
  expect((await malformed.json()).__type).toBe("SerializationException")
  expect((await runtime.fetch(new Request("http://mock/__admin/health"))).status).toBe(200)
})

test("AWS writes are observable, namespace isolated, and cleared by reset", async () => {
  const runtime = createRuntime()
  const call = async (operation: string, input: unknown, namespace = "default") => {
    const response = await runtime.fetch(
      new Request("http://mock/", {
        method: "POST",
        headers: {
          "content-type": "application/x-amz-json-1.1",
          "x-amz-target": `Fixture.${operation}`,
          "x-mockingbird-namespace": namespace,
        },
        body: JSON.stringify(input),
      }),
    )
    expect(response.status).toBe(200)
    return response.json()
  }
  const before = await call("ListIdentities", {})
  expect(Array.isArray(before["Identities"])).toBe(true)
  await call("VerifyEmailIdentity", { EmailAddress: "fixture@example.test" })
  expect((await call("ListIdentities", {}))["Identities"]).toHaveLength(
    before["Identities"].length + 1,
  )
  expect((await call("ListIdentities", {}, "isolated"))["Identities"]).toEqual(before["Identities"])
  await runtime.reset()
  expect((await call("ListIdentities", {}))["Identities"]).toEqual(before["Identities"])
})

test("SendEmail accepts a verified Source written with a display name", async () => {
  const runtime = createRuntime()
  const call = (operation: string, input: unknown) =>
    runtime.fetch(
      new Request("http://mock/", {
        method: "POST",
        headers: {
          "content-type": "application/x-amz-json-1.1",
          "x-amz-target": `SimpleEmailService.${operation}`,
        },
        body: JSON.stringify(input),
      }),
    )
  await call("VerifyEmailIdentity", { EmailAddress: "billing@example.com" })
  const message = {
    Destination: { ToAddresses: ["ada@example.com"] },
    Message: { Subject: { Data: "Receipt" }, Body: { Text: { Data: "Thanks" } } },
  }
  const named = await call("SendEmail", { ...message, Source: '"Billing" <billing@example.com>' })
  expect(named.status).toBe(200)
  const unverified = await call("SendEmail", {
    ...message,
    Source: "Other <other@elsewhere.example>",
  })
  expect(unverified.status).toBe(400)
})
