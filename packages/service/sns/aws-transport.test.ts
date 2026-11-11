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
  const before = await call("ListTopics", {})
  expect(Array.isArray(before["Topics"])).toBe(true)
  await call("CreateTopic", { Name: "fixture" })
  expect((await call("ListTopics", {}))["Topics"]).toHaveLength(before["Topics"].length + 1)
  expect((await call("ListTopics", {}, "isolated"))["Topics"]).toEqual(before["Topics"])
  await runtime.reset()
  expect((await call("ListTopics", {}))["Topics"]).toEqual(before["Topics"])
})

test("Publish to a PhoneNumber sends a direct SMS without a topic", async () => {
  const runtime = createRuntime()
  const publish = (input: unknown) =>
    runtime.fetch(
      new Request("http://mock/", {
        method: "POST",
        headers: {
          "content-type": "application/x-amz-json-1.1",
          "x-amz-target": "AmazonSNS.Publish",
        },
        body: JSON.stringify(input),
      }),
    )
  const sent = await publish({ PhoneNumber: "+12025550123", Message: "Your code is 123456" })
  expect(sent.status).toBe(200)
  const { MessageId } = await sent.json()
  const state = await (
    await runtime.fetch(new Request("http://mock/__admin/state/sns_messages"))
  ).json()
  expect(state.records).toHaveLength(1)
  expect(state.records[0].value).toMatchObject({
    MessageId,
    PhoneNumber: "+12025550123",
    Message: "Your code is 123456",
  })
  const invalid = await publish({ PhoneNumber: "2025550123", Message: "x" })
  expect(invalid.status).toBe(400)
  expect((await invalid.json()).__type).toBe("InvalidParameter")
})
