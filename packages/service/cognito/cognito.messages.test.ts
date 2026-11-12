import { describe, expect, test } from "bun:test"
import { createRuntime } from "./src/runtime.js"

const origin = "http://cognito.test"
const clientId = "fixture-client"
const call = async (
  runtime: ReturnType<typeof createRuntime>,
  target: string,
  body: unknown,
  headers: Record<string, string> = {},
) => {
  const response = await runtime.fetch(
    new Request(`${origin}/`, {
      method: "POST",
      headers: {
        "content-type": "application/x-amz-json-1.1",
        "x-amz-target": `AWSCognitoIdentityProviderService.${target}`,
        ...headers,
      },
      body: JSON.stringify(body),
    }),
  )
  return { status: response.status, body: await response.json() }
}
const admin = async (runtime: ReturnType<typeof createRuntime>, path: string) => {
  const response = await runtime.fetch(new Request(`${origin}/__admin${path}`))
  return { status: response.status, body: await response.json() }
}
const signUp = (
  runtime: ReturnType<typeof createRuntime>,
  username: string,
  attributes: { Name: string; Value: string }[],
) =>
  call(runtime, "SignUp", {
    ClientId: clientId,
    Username: username,
    Password: "Password!122",
    UserAttributes: attributes,
  })
const adminAuth = { authorization: "AWS4-HMAC-SHA256 Credential=fixture/20260101/us-east-1" }

describe("Cognito delivered messages (GET /__admin/outbox)", () => {
  test("SignUp delivers Cognito's default verification email with the code /__admin/codes reports", async () => {
    const runtime = createRuntime({ clientId })
    const signed = await signUp(runtime, "ada@example.test", [
      { Name: "email", Value: "ada@example.test" },
    ])
    expect(signed.body.CodeDeliveryDetails).toEqual({
      Destination: "ada@example.test",
      DeliveryMedium: "EMAIL",
      AttributeName: "email",
    })
    const codes = await admin(runtime, "/codes?username=ada%40example.test")
    const { messages } = (await admin(runtime, "/outbox")).body
    expect(messages).toEqual([
      {
        id: expect.any(String),
        to: "ada@example.test",
        createdAt: expect.any(String),
        channel: "email",
        deliveryMedium: "EMAIL",
        attributeName: "email",
        username: "ada@example.test",
        trigger: "SignUp",
        code: codes.body.confirmationCode,
        from: "no-reply@verificationemail.com",
        subject: "Your verification code",
        body: `Your verification code is ${codes.body.confirmationCode}.`,
      },
    ])
  })

  test("ResendConfirmationCode and ForgotPassword each deliver another message with the new code", async () => {
    const runtime = createRuntime({ clientId })
    await signUp(runtime, "ada@example.test", [{ Name: "email", Value: "ada@example.test" }])
    await call(runtime, "ResendConfirmationCode", {
      ClientId: clientId,
      Username: "ada@example.test",
    })
    await call(runtime, "ForgotPassword", { ClientId: clientId, Username: "ada@example.test" })
    const codes = (await admin(runtime, "/codes?username=ada%40example.test")).body
    const { messages } = (await admin(runtime, "/outbox?to=ADA%40example.test")).body
    expect(messages.map((m: { trigger: string; code: string }) => [m.trigger, m.code])).toEqual([
      ["SignUp", codes.confirmationCode],
      ["ResendConfirmationCode", codes.confirmationCode],
      ["ForgotPassword", codes.resetCode],
    ])
    const forgot = (await admin(runtime, "/outbox?trigger=ForgotPassword")).body.messages
    expect(forgot).toHaveLength(1)
    expect(forgot[0].body).toContain(codes.resetCode)
  })

  test("a user with only a phone_number gets the code by SMS", async () => {
    const runtime = createRuntime({ clientId })
    const signed = await signUp(runtime, "grace", [{ Name: "phone_number", Value: "+12025550142" }])
    expect(signed.body.CodeDeliveryDetails).toEqual({
      Destination: "+12025550142",
      DeliveryMedium: "SMS",
      AttributeName: "phone_number",
    })
    const { messages } = (await admin(runtime, "/outbox?channel=sms")).body
    expect(messages).toMatchObject([
      {
        to: "+12025550142",
        deliveryMedium: "SMS",
        attributeName: "phone_number",
        trigger: "SignUp",
        code: "123456",
        subject: null,
        body: "Your verification code is 123456.",
      },
    ])
  })

  test("AdminCreateUser sends the temporary-password invitation unless MessageAction is SUPPRESS", async () => {
    const runtime = createRuntime({ clientId })
    await call(
      runtime,
      "AdminCreateUser",
      {
        Username: "linus",
        TemporaryPassword: "Temporary1",
        DesiredDeliveryMediums: ["EMAIL"],
        UserAttributes: [{ Name: "email", Value: "linus@example.test" }],
      },
      adminAuth,
    )
    await call(
      runtime,
      "AdminCreateUser",
      {
        Username: "quiet",
        MessageAction: "SUPPRESS",
        UserAttributes: [{ Name: "email", Value: "quiet@example.test" }],
      },
      adminAuth,
    )
    const { messages } = (await admin(runtime, "/outbox")).body
    expect(messages).toMatchObject([
      {
        to: "linus@example.test",
        trigger: "AdminCreateUser",
        code: null,
        subject: "Your temporary password",
        body: "Your username is linus and temporary password is Temporary1.",
      },
    ])
  })

  test("messages stay in the namespace they were sent in", async () => {
    const runtime = createRuntime({ clientId })
    await call(
      runtime,
      "SignUp",
      {
        ClientId: clientId,
        Username: "ada@example.test",
        Password: "Password!122",
        UserAttributes: [{ Name: "email", Value: "ada@example.test" }],
      },
      { "x-mockingbird-namespace": "beta" },
    )
    expect((await admin(runtime, "/outbox")).body.messages).toEqual([])
    const beta = await runtime.fetch(
      new Request(`${origin}/__admin/outbox`, { headers: { "x-mockingbird-namespace": "beta" } }),
    )
    expect((await beta.json()).messages).toHaveLength(1)
  })
})

test("GET /__admin/codes without ?username= is a 400 naming the parameter", async () => {
  const runtime = createRuntime({ clientId })
  for (const path of ["/codes", "/codes?username="]) {
    const response = await admin(runtime, path)
    expect(response.status).toBe(400)
    expect(response.body).toEqual({
      error: { type: "mockingbird_admin", message: "the username query parameter is required" },
    })
  }
  expect((await admin(runtime, "/codes?username=nobody")).status).toBe(404)
})
