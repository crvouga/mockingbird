import { describe, expect, test } from "bun:test"
import { createHmac } from "node:crypto"
import {
  createRuntime,
  DEVELOPMENT_ENVIRONMENT_ID,
  FORMBRICKS_PRESETS,
  PRODUCTION_ENVIRONMENT_ID,
  WEBHOOK_PATH,
} from "./src/index.js"
import { createServer } from "./src/server.js"
import {
  ApiResponseError,
  BackendFormbricks,
  cli,
  type FormSubmissionRejected,
  MemberAppFormbricks,
  WebhookReceiver,
} from "./test/consumer.js"

const APP = "http://formbricks.mock"
const TOKEN = "formbricks-webhook-token"
const SIGNING = `whsec_${btoa("formbricks-standard-webhooks-key!")}`
const ONBOARDING = "c8a390883c4f4be3aa1742987"
const NPS = "cmpx0qyv8005apb015lmthk2f"

/** A complete, valid Onboarding Intake (every required element answered). */
const onboardingAnswers = (overrides: Record<string, unknown> = {}) =>
  Object.entries({
    elem_firstname_001: "Ada",
    elem_lastname_002: "Lovelace",
    elem_dob_003: "1990-12-10",
    elem_phone_009: "+1 602 555 0142",
    elem_address1_004: "1 Main St",
    elem_city_006: "Phoenix",
    elem_state_007: "AZ",
    elem_zip_008: "85001",
    af1b4a0daf144a23bccf88d2e: "Female",
    d1bb6a2036924811bce4c3b35: ["Maximize longevity"],
    "0e38197a5a594c2f87eab6756": ["Instagram"],
    ca84e539911844959f4cc8936: "Yes",
    ...overrides,
  }).map(([questionId, value]) => ({ questionId, value }))

const harness = () => {
  const deliveries: Request[] = []
  const runtime = createRuntime({
    webhooks: {
      url: `http://backend.local${WEBHOOK_PATH}?token=${TOKEN}`,
      secret: SIGNING,
      fetch: async (request) => {
        deliveries.push(request)
        return Response.json({ ok: true })
      },
    },
  })
  const send = (request: Request) => runtime.fetch(request)
  const member = new MemberAppFormbricks(APP, PRODUCTION_ENVIRONMENT_ID, send)
  const backend = new BackendFormbricks(APP, "fbk_key", PRODUCTION_ENVIRONMENT_ID, send)
  const receiver = new WebhookReceiver(TOKEN, APP, PRODUCTION_ENVIRONMENT_ID)
  const receive = async () => {
    await runtime.webhooks.idle()
    const out: { status: number; body: unknown }[] = []
    for (const request of deliveries.splice(0)) out.push(await receiver.receive(request))
    return out
  }
  return { runtime, send, member, backend, receiver, receive, deliveries }
}

describe("S20 Formbricks acceptance: our consumers' logic against the mock", () => {
  test("the member app loads surveys from the environment state (prod clone, both envs)", async () => {
    const { member, send, backend } = harness()
    const survey = await member.survey(ONBOARDING)
    expect(survey.name).toBe("Onboarding Intake")
    expect(Array.isArray(survey.blocks)).toBe(true)
    expect((await backend.clientSurveys()).length).toBe(9)
    const dev = new MemberAppFormbricks(APP, DEVELOPMENT_ENVIRONMENT_ID, send)
    expect((await dev.surveys()).map((s) => s.id)).toContain(ONBOARDING)
    await expect(member.survey("cnosuchsurvey000000000000")).rejects.toThrow("Survey not found")
  })

  test("a finished submission is stored, and responseFinished reaches our receiver with the token", async () => {
    const { member, receive, receiver, deliveries, runtime } = harness()
    const { id, attempts } = await member.submitAnswers({
      formId: ONBOARDING,
      answers: onboardingAnswers(),
      gevitiUserId: "42",
      cognitoSub: "sub-42",
      userId: "ada@example.com",
    })
    expect(id).toMatch(/^c[0-9a-z]{24}$/)
    expect(attempts).toBe(1)
    await runtime.webhooks.idle()
    const request = deliveries[0] as Request
    expect(new URL(request.url).searchParams.get("token")).toBe(TOKEN)
    const body = await request.clone().text()
    const payload = JSON.parse(body) as {
      webhookId: string
      event: string
      data: {
        id: string
        surveyId: string
        finished: boolean
        data: Record<string, unknown>
        contact: { userId: string }
        meta: Record<string, unknown>
        survey: { title: string }
      }
    }
    expect(payload.event).toBe("responseFinished")
    expect(payload.data).toMatchObject({
      id,
      surveyId: ONBOARDING,
      finished: true,
      contact: { userId: "ada@example.com" },
      meta: { gevitiUserId: "42", cognitoSub: "sub-42" },
      survey: { title: "Onboarding Intake" },
    })
    expect(payload.data.data.__gevitiUserId).toBe("42")
    // Standard Webhooks signature, checked independently with node:crypto.
    const msgId = request.headers.get("webhook-id") as string
    const ts = request.headers.get("webhook-timestamp") as string
    const key = Buffer.from(SIGNING.slice("whsec_".length), "base64")
    const expected = createHmac("sha256", key).update(`${msgId}.${ts}.${body}`).digest("base64")
    expect(request.headers.get("webhook-signature")).toBe(`v1,${expected}`)
    expect(await receive()).toEqual([{ status: 200, body: { ok: true } }])
    expect(receiver.completed).toEqual([
      {
        email: "ada@example.com",
        metadata: {
          formbricksResponseUrl: `${APP}/environments/${PRODUCTION_ENVIRONMENT_ID}/surveys/${ONBOARDING}/responses?responseId=${id}`,
          surveyId: ONBOARDING,
          responseId: id,
        },
      },
    ])
  })

  test("a missing required answer is 400 Validation failed keyed response.data.<id>", async () => {
    const { member, backend, send } = harness()
    const answers = onboardingAnswers().filter((a) => a.questionId !== "elem_lastname_002")
    const error = (await member
      .submitAnswers({ formId: ONBOARDING, answers })
      .catch((e: unknown) => e)) as ApiResponseError
    expect(error).toBeInstanceOf(ApiResponseError)
    expect(error.status).toBe(400)
    expect(error.message).toBe("Validation failed")
    expect(error.payload).toEqual({
      code: "bad_request",
      message: "Validation failed",
      details: { "response.data.elem_lastname_002": "Please fill out this field" },
    })
    // The backend maps any 4xx to 422 FORM_SUBMISSION_REJECTED and passes details through.
    const data = Object.fromEntries(
      onboardingAnswers({ elem_phone_009: "call me" }).map((a) => [a.questionId, a.value]),
    )
    const rejected = (await backend
      .submitResponse(ONBOARDING, 42, data)
      .catch((e: unknown) => e)) as FormSubmissionRejected
    expect(rejected.statusCode).toBe(422)
    expect(rejected.body).toEqual({
      code: "FORM_SUBMISSION_REJECTED",
      message: "Form submission was rejected: Validation failed",
      formbricksStatus: 400,
      details: { "response.data.elem_phone_009": "Please enter a valid phone number" },
    })
    // Unfinished responses are only checked for the fields present.
    const partial = await send(
      new Request(`${APP}/api/v2/client/${PRODUCTION_ENVIRONMENT_ID}/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          surveyId: ONBOARDING,
          finished: false,
          data: { elem_city_006: "X" },
        }),
      }),
    )
    expect(partial.status).toBe(200)
  })

  test("429 is retried three times by the member app", async () => {
    const recovers = harness()
    recovers.runtime.applyPreset("rate_limited", "default", { count: 2 })
    const ok = await recovers.member.submitAnswers({ formId: NPS, answers: [] })
    expect(ok.attempts).toBe(3)
    const gives = harness()
    gives.runtime.applyPreset("rate_limited", "default", { count: 3 })
    const error = (await gives.member
      .submitAnswers({ formId: NPS, answers: [] })
      .catch((e: unknown) => e)) as ApiResponseError
    expect(error.status).toBe(429)
    expect(error.code).toBe("too_many_requests")
  })

  test("request-shape errors, unknown surveys and environments, and foreign surveys", async () => {
    const { send, backend } = harness()
    const post = (env: string, body: unknown) =>
      send(
        new Request(`${APP}/api/v2/client/${env}/responses`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
      ).then(async (r) => ({ status: r.status, body: await r.json() }))
    expect(await post(PRODUCTION_ENVIRONMENT_ID, { surveyId: "Not-A-Cuid", data: {} })).toEqual({
      status: 400,
      body: {
        code: "bad_request",
        message: "Fields are missing or incorrectly formatted",
        details: { surveyId: "Invalid cuid2", finished: "Required" },
      },
    })
    expect(
      await post(PRODUCTION_ENVIRONMENT_ID, {
        surveyId: "cnosuchsurvey000000000000",
        finished: true,
        data: {},
      }),
    ).toMatchObject({ status: 404, body: { code: "not_found", message: "Survey not found" } })
    const env = await send(new Request(`${APP}/api/v1/client/Bad_Env/environment`))
    expect(env.status).toBe(400)
    const unknown = await send(
      new Request(`${APP}/api/v1/client/cunknownenv0000000000000/environment`),
    )
    expect(unknown.status).toBe(404)
    // A survey created in the dev environment is refused through the prod environment.
    const created = await send(
      new Request(`${APP}/api/v1/management/surveys`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": "k" },
        body: JSON.stringify({ environmentId: DEVELOPMENT_ENVIRONMENT_ID, name: "Dev only" }),
      }),
    )
    const { data: survey } = (await created.json()) as { data: { id: string } }
    const foreign = await post(PRODUCTION_ENVIRONMENT_ID, {
      surveyId: survey.id,
      finished: true,
      data: {},
    })
    expect(foreign).toMatchObject({
      status: 400,
      body: { message: "Survey is part of another environment" },
    })
    const rejected = (await backend
      .submitResponse("cnosuchsurvey000000000000", 1, {})
      .catch((e: unknown) => e)) as FormSubmissionRejected
    expect(rejected.statusCode).toBe(422)
  })

  test("upstream failures: 500 → 502, a success without an id → receipt missing", async () => {
    const failing = harness()
    failing.runtime.applyPreset("server_error", "default", { count: 1 })
    const upstream = (await failing.backend
      .submitResponse(NPS, 1, {})
      .catch((e: unknown) => e)) as FormSubmissionRejected
    expect(upstream.statusCode).toBe(502)
    const noId = harness()
    noId.runtime.applyPreset("missing_response_id", "default", { count: 1 })
    const receipt = (await noId.backend
      .submitResponse(NPS, 1, {}, { receipt: true })
      .catch((e: unknown) => e)) as FormSubmissionRejected
    expect(receipt.body.code).toBe("FORM_SUBMISSION_RECEIPT_MISSING")
    expect(receipt.statusCode).toBe(502)
    expect(await noId.backend.submitResponse(NPS, 1, {}, { receipt: true })).toEqual({
      responseId: expect.stringMatching(/^c[0-9a-z]{24}$/),
    })
  })

  test("management responses: the member's latest answers, data as object or JSON string", async () => {
    const { runtime, backend } = harness()
    await backend.submitResponse(NPS, 7, { q1: "first" })
    runtime.clock.advance(60_000)
    await backend.submitResponse(NPS, 7, { q1: "second" })
    await backend.submitResponse(NPS, 8, { q1: "someone else" })
    expect(await backend.getResponses(NPS, 7)).toEqual([{ linkId: "q1", answers: ["second"] }])
    runtime.applyPreset("data_as_string", "default")
    expect(await backend.getResponses(NPS, 7)).toEqual([{ linkId: "q1", answers: ["second"] }])
    const raw = (await (
      await runtime.fetch(
        new Request(`${APP}/api/v1/management/responses?surveyId=${NPS}`, {
          headers: { "x-api-key": "k" },
        }),
      )
    ).json()) as { data: { data: unknown }[] }
    expect(typeof raw.data[0]?.data).toBe("string")
    const noKey = await runtime.fetch(new Request(`${APP}/api/v1/management/responses`))
    expect(noKey.status).toBe(401)
    expect(await noKey.json()).toEqual({
      code: "not_authenticated",
      message: "Not authenticated",
      details: { "x-Api-Key": "Header not provided or API Key invalid" },
    })
    runtime.applyPreset("management_unauthorized", "default", { count: 1 })
    expect(await backend.getResponses(NPS, 7)).toEqual([])
  })

  test("management surveys: intake metadata, CLI reads, 404 → null", async () => {
    const { send, backend } = harness()
    const created = (await (
      await send(
        new Request(`${APP}/api/v1/management/surveys`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-api-key": "k" },
          body: JSON.stringify({
            environmentId: PRODUCTION_ENVIRONMENT_ID,
            name: "Intake with tags",
            type: "app",
            status: "inProgress",
            questions: [
              {
                id: "q_dob",
                type: "date",
                headline: { default: "DOB" },
                metadata: { intakeField: "dateOfBirth" },
              },
              { id: "q_note", type: "openText", headline: { default: "Notes" } },
            ],
          }),
        }),
      )
    ).json()) as { data: { id: string } }
    expect(await backend.intakeFields(created.data.id)).toEqual(new Map([["q_dob", "dateOfBirth"]]))
    // The prod clone's surveys carry blocks, not questions: nothing is tagged.
    expect(await backend.intakeFields(ONBOARDING)).toEqual(new Map())
    const tool = cli(APP, "k", PRODUCTION_ENVIRONMENT_ID, send)
    expect((await tool.listSurveys()).length).toBe(10)
    expect(await tool.getSurvey("cnosuchsurvey000000000000")).toBeNull()
    expect((await tool.getSurvey(ONBOARDING))?.id).toBe(ONBOARDING)
    const responseId = (await backend.submitResponse(NPS, 3, {}, { receipt: true }))?.responseId
    expect((await tool.getResponse(responseId as string))?.id).toBe(responseId as string)
    expect(await tool.getResponse("cnosuchresponse0000000000")).toBeNull()
    expect(await tool.listResponses(NPS)).toHaveLength(1)
  })

  test("duplicate: the webhook arrives twice and our receiver completes the task twice", async () => {
    const { runtime, member, receive, receiver } = harness()
    runtime.applyPreset("duplicate", "default")
    await member.submitAnswers({
      formId: ONBOARDING,
      answers: onboardingAnswers(),
      userId: "ada@example.com",
    })
    expect((await receive()).map((r) => r.status)).toEqual([200, 200])
    expect(receiver.completed).toHaveLength(2)
  })

  test("only the query token is checked: a wrong or missing token is 403", async () => {
    const { runtime, member, deliveries } = harness()
    await member.submitAnswers({ formId: NPS, answers: [], userId: "a@example.com" })
    await runtime.webhooks.idle()
    const request = deliveries[0] as Request
    const wrong = new WebhookReceiver("another-token", APP, PRODUCTION_ENVIRONMENT_ID)
    expect((await wrong.receive(request.clone())).status).toBe(403)
    const url = new URL(request.url)
    url.search = ""
    const stripped = new Request(url, {
      method: "POST",
      headers: request.headers,
      body: await request.clone().text(),
    })
    expect(
      (await new WebhookReceiver(TOKEN, APP, PRODUCTION_ENVIRONMENT_ID).receive(stripped)).status,
    ).toBe(403)
  })

  test("an unfinished response emits responseCreated only, to webhooks that subscribe to it", async () => {
    const { send, deliveries, runtime } = harness()
    const post = () =>
      send(
        new Request(`${APP}/api/v2/client/${PRODUCTION_ENVIRONMENT_ID}/responses`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ surveyId: NPS, finished: false, data: {} }),
        }),
      )
    await post()
    await runtime.webhooks.idle()
    expect(deliveries).toHaveLength(0)
    await runtime.fetch(
      new Request(`${APP}/__admin/webhook-endpoints`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify([{ url: "http://backend.local/all", events: ["responseCreated"] }]),
      }),
    )
    await post()
    const events = (await (
      await runtime.fetch(new Request(`${APP}/__admin/webhooks/events`))
    ).json()) as { events: { type: string }[] }
    expect(events.events.map((e) => e.type)).toEqual(["responseCreated"])
  })

  test("the widget script is a no-op that defines window.formbricks", async () => {
    const { member } = harness()
    expect(await member.loadWidget()).toBe(true)
  })

  test("namespaces by environment id (the member app cannot add headers); no answers in the journal", async () => {
    const { runtime, send } = harness()
    await runtime.fetch(
      new Request(`${APP}/__admin/credentials`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ credentials: { [DEVELOPMENT_ENVIRONMENT_ID]: "worker-1" } }),
      }),
    )
    const dev = new MemberAppFormbricks(APP, DEVELOPMENT_ENVIRONMENT_ID, send)
    await dev.submitAnswers({
      formId: ONBOARDING,
      answers: onboardingAnswers({ elem_firstname_001: "Secretname" }),
    })
    const read = async (query: string) =>
      (await (await runtime.fetch(new Request(`${APP}/__admin/responses${query}`))).json()) as {
        responses: unknown[]
      }
    expect((await read("")).responses).toHaveLength(0)
    expect((await read("?namespace=worker-1")).responses).toHaveLength(1)
    const journal = await (
      await runtime.fetch(new Request(`${APP}/__admin/requests?namespace=worker-1`))
    ).text()
    expect(journal).toContain("CreateClientResponse")
    expect(journal).not.toContain("Secretname")
  })

  test("every documented preset is registered", () => {
    expect(Object.keys(FORMBRICKS_PRESETS)).toEqual(
      expect.arrayContaining([
        "rate_limited",
        "duplicate",
        "data_as_string",
        "missing_response_id",
        "server_error",
      ]),
    )
  })
})

describe("served over HTTP", () => {
  test("the member app submits to the node server and the webhook reaches a real sink", async () => {
    const receiver = new WebhookReceiver(TOKEN, "http://x", PRODUCTION_ENVIRONMENT_ID)
    const sink = Bun.serve({
      port: 0,
      fetch: async (request) => {
        const outcome = await receiver.receive(request)
        return Response.json(outcome.body, { status: outcome.status })
      },
    })
    const server = await createServer({
      webhooks: { url: `http://127.0.0.1:${sink.port}${WEBHOOK_PATH}?token=${TOKEN}` },
    })
    try {
      const member = new MemberAppFormbricks(server.url, PRODUCTION_ENVIRONMENT_ID, (r) => fetch(r))
      await member.submitAnswers({
        formId: ONBOARDING,
        answers: onboardingAnswers(),
        userId: "ada@example.com",
      })
      const deadline = Date.now() + 3_000
      while (receiver.completed.length < 1 && Date.now() < deadline) await Bun.sleep(25)
      expect(receiver.completed.map((c) => c.email)).toEqual(["ada@example.com"])
      expect(await member.loadWidget()).toBe(true)
      const health = await fetch(`${server.url}/health`)
      expect(health.headers.get("x-mockingbird")).toMatch(/^formbricks@/)
    } finally {
      await server.close()
      sink.stop(true)
    }
  })
})

describe("contract", () => {
  test("namespaces by header and by /ns/ prefix are isolated; reset clears one namespace", async () => {
    const runtime = createRuntime()
    const get = (url: string, headers: Record<string, string> = {}) =>
      runtime.fetch(new Request(url, { headers: { "x-api-key": "k", ...headers } }))
    const base = "http://mock.local"
    // Seed state in namespace "a" through the header, then compare with "b" and the default.
    const before = (await (await get(`${base}/api/v1/management/surveys`)).json()) as Record<
      string,
      unknown[]
    >
    const viaHeader = await get(`${base}/api/v1/management/surveys`, {
      "x-mockingbird-namespace": "a",
    })
    expect(viaHeader.headers.get("x-mockingbird")).toMatch(/; ns=a$/)
    const viaPrefix = await get(`${base}/ns/b/api/v1/management/surveys`)
    expect(viaPrefix.status).toBe(viaHeader.status)
    expect(viaPrefix.headers.get("x-mockingbird")).toMatch(/; ns=b$/)
    expect(((await viaPrefix.json()) as Record<string, unknown[]>).data?.length).toBe(
      before.data?.length,
    )
    const reset = await runtime.fetch(
      new Request(`${base}/__admin/reset?namespace=a`, { method: "POST" }),
    )
    expect(reset.status).toBeLessThan(300)
    const health = (await (await runtime.fetch(new Request(`${base}/health`))).json()) as {
      status: string
    }
    expect(health.status).toBe("ok")
  })
})
