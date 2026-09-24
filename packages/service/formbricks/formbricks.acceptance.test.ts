import { describe, expect, test } from "bun:test"
import { createHmac } from "node:crypto"
import {
  createRuntime,
  ENVIRONMENT_ID,
  FORMBRICKS_PRESETS,
  WEBHOOK_PATH,
  WORKSPACE_ID,
} from "./src/index.js"
import { createServer } from "./src/server.js"
import {
  ApiResponseError,
  cli,
  type FormSubmissionRejected,
  SurveyBackend,
  SurveyClient,
  WebhookReceiver,
} from "./test/consumer.js"

const APP = "http://formbricks.mock"
const TOKEN = "formbricks-webhook-token"
const SIGNING = `whsec_${btoa("formbricks-standard-webhooks-key!")}`
const NPS = "csurveynps000000000000001"
const ONBOARDING = "csurveyonboarding00000001"
const FEEDBACK = "csurveyfeedback0000000001"
const EVENT = "csurveyevent0000000000001"
const EXIT = "csurveyexit00000000000001"
const MISSING = "cnosuchsurvey000000000000"

type SurveyBody = { id: string; blocks: { name: string }[]; [key: string]: unknown }

/** A complete, valid Onboarding response. */
const onboardingAnswers = (overrides: Record<string, unknown> = {}) => ({
  first_name: "Ada",
  last_name: "Lovelace",
  work_email: "ada@example.com",
  phone: "+1 555 0100",
  role: "engineering",
  team_size: "small",
  ...overrides,
})

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
  const client = new SurveyClient(APP, WORKSPACE_ID, send)
  const backend = new SurveyBackend(APP, "fbk_key", WORKSPACE_ID, send)
  const receiver = new WebhookReceiver(TOKEN)
  const receive = async () => {
    await runtime.webhooks.idle()
    const out: { status: number; body: unknown }[] = []
    for (const request of deliveries.splice(0)) out.push(await receiver.receive(request))
    return out
  }
  const post = (workspace: string, body: unknown) =>
    send(
      new Request(`${APP}/api/v2/client/${workspace}/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    ).then(async (r) => ({ status: r.status, body: await r.json() }))
  const admin = (method: string, path: string, body?: unknown) =>
    runtime.fetch(
      new Request(`${APP}/__admin${path}`, {
        method,
        headers: { "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    )
  return { runtime, send, client, backend, receiver, receive, deliveries, post, admin }
}

describe("Formbricks acceptance: a consumer app's integration against the mock", () => {
  test("the SDK loads app surveys in progress from the environment state (workspace or legacy environment id)", async () => {
    const { client, send, backend } = harness()
    const survey = await client.survey(ONBOARDING)
    expect(survey.name).toBe("Onboarding")
    expect(Array.isArray(survey.blocks)).toBe(true)
    expect(survey.projectOverwrites).toBeNull()
    // Link surveys and paused surveys are not shipped to the SDK.
    expect((await backend.clientSurveys()).map((s) => s.id)).toEqual([NPS, ONBOARDING, FEEDBACK])
    const legacy = new SurveyClient(APP, ENVIRONMENT_ID, send)
    expect((await legacy.surveys()).map((s) => s.id)).toContain(ONBOARDING)
    const state = (await (
      await send(new Request(`${APP}/api/v1/client/${ENVIRONMENT_ID}/environment`))
    ).json()) as { data: { data: { workspace: { id: string }; project: { id: string } } } }
    expect(state.data.data.workspace.id).toBe(WORKSPACE_ID)
    expect(state.data.data.project).toEqual(state.data.data.workspace)
    await expect(client.survey(EVENT)).rejects.toThrow("Survey not found")
  })

  test("a finished submission is stored, and responseFinished reaches the receiver signed", async () => {
    const { client, receive, receiver, deliveries, runtime } = harness()
    const { id, attempts } = await client.submitAnswers({
      surveyId: ONBOARDING,
      answers: onboardingAnswers({ not_an_element: "dropped" }),
      accountId: "acct_42",
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
      data: Record<string, unknown> & { data: Record<string, unknown> }
    }
    expect(payload.event).toBe("responseFinished")
    expect(payload.data).toMatchObject({
      id,
      surveyId: ONBOARDING,
      finished: true,
      contact: null,
      language: null,
      meta: { userAgent: { device: "desktop" } },
      survey: { title: "Onboarding", type: "app", status: "inProgress" },
    })
    // Unknown keys are dropped by the ingest contract; declared hidden fields are kept.
    expect(payload.data.data).toEqual({ ...onboardingAnswers(), accountId: "acct_42" })
    // Standard Webhooks signature, checked independently with node:crypto.
    const msgId = request.headers.get("webhook-id") as string
    const ts = request.headers.get("webhook-timestamp") as string
    const key = Buffer.from(SIGNING.slice("whsec_".length), "base64")
    const expected = createHmac("sha256", key).update(`${msgId}.${ts}.${body}`).digest("base64")
    expect(request.headers.get("webhook-signature")).toBe(`v1,${expected}`)
    expect(await receive()).toEqual([{ status: 200, body: { ok: true } }])
    expect(receiver.completed).toEqual([
      { accountId: "acct_42", surveyId: ONBOARDING, responseId: id },
    ])
  })

  test("element validation: 400 Validation failed keyed response.data.<id>, present elements only", async () => {
    const { client, backend, post } = harness()
    const error = (await client
      .submitAnswers({ surveyId: ONBOARDING, answers: onboardingAnswers({ last_name: "" }) })
      .catch((e: unknown) => e)) as ApiResponseError
    expect(error).toBeInstanceOf(ApiResponseError)
    expect(error.status).toBe(400)
    expect(error.message).toBe("Validation failed")
    expect(error.payload).toEqual({
      code: "bad_request",
      message: "Validation failed",
      details: { "response.data.last_name": "Please fill out this field" },
    })
    const rejected = (await backend
      .submitResponse(ONBOARDING, "acct_1", onboardingAnswers({ phone: "call me", team_size: "9" }))
      .catch((e: unknown) => e)) as FormSubmissionRejected
    expect(rejected.statusCode).toBe(422)
    expect(rejected.body).toEqual({
      code: "FORM_SUBMISSION_REJECTED",
      message: "Form submission was rejected: Validation failed",
      formbricksStatus: 400,
      details: {
        "response.data.phone": "Please enter a valid phone number",
        "response.data.team_size": "Please enter a valid format",
      },
    })
    const invalid = await post(WORKSPACE_ID, {
      surveyId: ONBOARDING,
      finished: true,
      data: { work_email: "nope", website: "not a url", role: "Something else" },
    })
    expect(invalid).toEqual({
      status: 400,
      body: {
        code: "bad_request",
        message: "Validation failed",
        details: {
          "response.data.work_email": "Please enter a valid email address",
          "response.data.website": "Please enter a valid URL",
        },
      },
    })
    // Absent elements are never checked, even when the response is finished.
    expect(
      (
        await post(WORKSPACE_ID, {
          surveyId: ONBOARDING,
          finished: true,
          data: { phone: "5550100" },
        })
      ).status,
    ).toBe(200)
  })

  test("429 is retried three times by the client", async () => {
    const recovers = harness()
    recovers.runtime.applyPreset("rate_limited", "default", { count: 2 })
    const ok = await recovers.client.submitAnswers({ surveyId: NPS, answers: {} })
    expect(ok.attempts).toBe(3)
    const gives = harness()
    gives.runtime.applyPreset("rate_limited", "default", { count: 3 })
    const error = (await gives.client
      .submitAnswers({ surveyId: NPS, answers: {} })
      .catch((e: unknown) => e)) as ApiResponseError
    expect(error.status).toBe(429)
    expect(error.code).toBe("too_many_requests")
  })

  test("request-shape errors, unknown surveys and workspaces, foreign and paused surveys", async () => {
    const { send, backend, post, admin } = harness()
    expect(await post(WORKSPACE_ID, { surveyId: "Not-A-Cuid", data: {}, userId: 5 })).toEqual({
      status: 400,
      body: {
        code: "bad_request",
        message: "Fields are missing or incorrectly formatted",
        details: {
          surveyId: "Invalid cuid2",
          finished: "Invalid input: expected boolean, received undefined",
        },
      },
    })
    expect(
      await post(WORKSPACE_ID, { surveyId: NPS, finished: "yes", data: { a: null }, ttc: [] }),
    ).toMatchObject({
      status: 400,
      body: {
        details: {
          finished: "Invalid input: expected boolean, received string",
          "data.a": "Invalid input",
          ttc: "Invalid input: expected record, received array",
        },
      },
    })
    expect(await post(WORKSPACE_ID, { surveyId: MISSING, finished: true, data: {} })).toEqual({
      status: 404,
      body: {
        code: "not_found",
        message: "Survey not found",
        details: { resource_id: MISSING, resource_type: "Survey" },
      },
    })
    expect(
      await post("cunknownworkspace00000000", { surveyId: NPS, finished: true, data: {} }),
    ).toMatchObject({ status: 404, body: { message: "Workspace not found" } })
    expect(await post(WORKSPACE_ID, { surveyId: EXIT, finished: true, data: {} })).toEqual({
      status: 403,
      body: {
        code: "forbidden",
        message: "Survey is not accepting submissions",
        details: { surveyId: EXIT },
      },
    })
    const env = await send(new Request(`${APP}/api/v1/client/Bad_Id/environment`))
    expect(await env.json()).toEqual({
      code: "bad_request",
      message: "Invalid ID format",
      details: {},
    })
    const unknown = await send(
      new Request(`${APP}/api/v1/client/cunknownworkspace00000000/environment`),
    )
    expect(unknown.status).toBe(404)
    // A survey of another workspace is refused through the default one.
    const other = "cotherworkspace0000000001"
    await admin("PUT", "/settings", { workspaces: [WORKSPACE_ID, other] })
    const created = await send(
      new Request(`${APP}/api/v1/management/surveys`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": "k" },
        body: JSON.stringify({
          workspaceId: other,
          name: "Other workspace",
          status: "inProgress",
          questions: [{ id: "q1", type: "openText", headline: { default: "Hi" }, required: false }],
        }),
      }),
    )
    const { data: survey } = (await created.json()) as { data: { id: string } }
    expect(await post(WORKSPACE_ID, { surveyId: survey.id, finished: true, data: {} })).toEqual({
      status: 400,
      body: {
        code: "bad_request",
        message: "Survey is part of another workspace",
        details: { workspaceId: WORKSPACE_ID },
      },
    })
    expect((await post(other, { surveyId: survey.id, finished: true, data: {} })).status).toBe(200)
    const rejected = (await backend
      .submitResponse(MISSING, "acct_1", {})
      .catch((e: unknown) => e)) as FormSubmissionRejected
    expect(rejected.statusCode).toBe(422)
  })

  test("contacts are an Enterprise feature: contactId is 403 until enabled", async () => {
    const { post, admin, send } = harness()
    const contactId = "ccontact00000000000000001"
    expect(
      await post(WORKSPACE_ID, { surveyId: NPS, finished: true, data: {}, contactId }),
    ).toEqual({
      status: 403,
      body: {
        code: "forbidden",
        message: "User identification is only available for enterprise users.",
        details: {},
      },
    })
    await admin("PUT", "/settings", { contactsEnabled: true })
    await admin("PUT", "/contacts", [
      { id: contactId, userId: "user-7", attributes: { plan: "pro" } },
    ])
    const ok = (await post(WORKSPACE_ID, {
      surveyId: NPS,
      finished: true,
      data: { nps_score: 9 },
      contactId,
      language: "en",
    })) as { status: number; body: { data: { id: string } } }
    expect(ok.status).toBe(200)
    const stored = (await (
      await send(
        new Request(`${APP}/api/v1/management/responses/${ok.body.data.id}`, {
          headers: { "x-api-key": "k" },
        }),
      )
    ).json()) as { data: Record<string, unknown> }
    expect(stored.data).toMatchObject({
      contact: { id: contactId, userId: "user-7" },
      contactAttributes: { plan: "pro", userId: "user-7" },
      language: "en-US",
    })
  })

  test("upstream failures: 500 → 502, a success without an id → receipt missing", async () => {
    const failing = harness()
    failing.runtime.applyPreset("server_error", "default", { count: 1 })
    const upstream = (await failing.backend
      .submitResponse(NPS, "acct_1", {})
      .catch((e: unknown) => e)) as FormSubmissionRejected
    expect(upstream.statusCode).toBe(502)
    const noId = harness()
    noId.runtime.applyPreset("missing_response_id", "default", { count: 1 })
    const receipt = (await noId.backend
      .submitResponse(NPS, "acct_1", {}, { receipt: true })
      .catch((e: unknown) => e)) as FormSubmissionRejected
    expect(receipt.body.code).toBe("FORM_SUBMISSION_RECEIPT_MISSING")
    expect(receipt.statusCode).toBe(502)
    expect(await noId.backend.submitResponse(NPS, "acct_1", {}, { receipt: true })).toEqual({
      responseId: expect.stringMatching(/^c[0-9a-z]{24}$/),
    })
  })

  test("management responses: a user's latest answers, data as object or JSON string", async () => {
    const { runtime, backend } = harness()
    await backend.submitResponse(NPS, "acct_7", { nps_reason: "first" })
    runtime.clock.advance(60_000)
    await backend.submitResponse(NPS, "acct_7", { nps_reason: "second" })
    await backend.submitResponse(NPS, "acct_8", { nps_reason: "someone else" })
    expect(await backend.latestAnswers(NPS, "acct_7")).toEqual([
      { elementId: "nps_reason", answers: ["second"] },
    ])
    runtime.applyPreset("data_as_string", "default")
    expect(await backend.latestAnswers(NPS, "acct_7")).toEqual([
      { elementId: "nps_reason", answers: ["second"] },
    ])
    const get = (path: string, key = "k") =>
      runtime.fetch(new Request(`${APP}${path}`, { headers: key ? { "x-api-key": key } : {} }))
    const raw = (await (await get(`/api/v1/management/responses?surveyId=${NPS}`)).json()) as {
      data: { data: unknown }[]
    }
    expect(typeof raw.data[0]?.data).toBe("string")
    const unknownSurvey = await get(`/api/v1/management/responses?surveyId=${MISSING}`)
    expect(unknownSurvey.status).toBe(404)
    const noKey = await get("/api/v1/management/responses", "")
    expect(noKey.status).toBe(401)
    expect(await noKey.json()).toEqual({
      code: "not_authenticated",
      message: "Not authenticated",
      details: { "x-Api-Key": "Header not provided or API Key invalid" },
    })
    runtime.applyPreset("management_unauthorized", "default", { count: 1 })
    expect(await backend.latestAnswers(NPS, "acct_7")).toEqual([])
  })

  test("management surveys: blocks → v1 questions, legacy questions → blocks, CLI reads", async () => {
    const { send, backend } = harness()
    const create = (body: unknown) =>
      send(
        new Request(`${APP}/api/v1/management/surveys`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-api-key": "k" },
          body: JSON.stringify(body),
        }),
      ).then(async (r) => ({ status: r.status, body: (await r.json()) as { data: SurveyBody } }))
    const created = await create({
      environmentId: ENVIRONMENT_ID,
      name: "Legacy questions",
      type: "app",
      questions: [
        { id: "q_date", type: "date", headline: { default: "When?" }, required: true },
        { id: "q_note", type: "openText", headline: { default: "Notes" }, required: false },
      ],
    })
    expect(created.status).toBe(200)
    expect(created.body.data).toMatchObject({
      name: "Legacy questions",
      status: "draft",
      workspaceId: WORKSPACE_ID,
      environmentId: ENVIRONMENT_ID,
    })
    expect(created.body.data.blocks.map((b) => b.name)).toEqual(["Block 1", "Block 2"])
    expect(await backend.surveyElements(created.body.data.id)).toEqual([
      { id: "q_date", type: "date", required: true },
      { id: "q_note", type: "openText", required: false },
    ])
    expect(await backend.surveyElements(NPS)).toEqual([
      { id: "nps_score", type: "nps", required: true },
      { id: "nps_reason", type: "openText", required: false },
      { id: "nps_value", type: "multipleChoiceMulti", required: false },
    ])
    expect(await create({ name: "No workspace", blocks: [] })).toMatchObject({
      status: 400,
      body: { message: "workspaceId must be provided" },
    })
    expect(await create({ workspaceId: WORKSPACE_ID, name: "Empty" })).toMatchObject({
      status: 400,
      body: { message: "Must provide either questions or blocks. Both cannot be empty." },
    })
    expect(await create({ workspaceId: WORKSPACE_ID })).toMatchObject({
      status: 400,
      body: { details: { name: "Invalid input: expected string, received undefined" } },
    })
    const tool = cli(APP, "k", send)
    const listed = await tool.listSurveys()
    expect(listed.map((s) => s.id)).toEqual([
      created.body.data.id,
      EXIT,
      EVENT,
      FEEDBACK,
      ONBOARDING,
      NPS,
    ])
    expect(listed.find((s) => s.id === NPS)).toMatchObject({
      workspaceId: WORKSPACE_ID,
      environmentId: ENVIRONMENT_ID,
    })
    expect(await tool.getSurvey(MISSING)).toBeNull()
    expect((await tool.getSurvey(ONBOARDING))?.id).toBe(ONBOARDING)
    const responseId = (await backend.submitResponse(NPS, "acct_3", {}, { receipt: true }))
      ?.responseId
    expect((await tool.getResponse(responseId as string))?.id).toBe(responseId as string)
    expect(await tool.getResponse("cnosuchresponse0000000000")).toBeNull()
    expect(await tool.listResponses(NPS)).toHaveLength(1)
  })

  test("duplicate: the webhook arrives twice and a non-deduping receiver records it twice", async () => {
    const { runtime, client, receive, receiver } = harness()
    runtime.applyPreset("duplicate", "default")
    await client.submitAnswers({
      surveyId: ONBOARDING,
      answers: onboardingAnswers(),
      accountId: "acct_1",
    })
    expect((await receive()).map((r) => r.status)).toEqual([200, 200])
    expect(receiver.completed).toHaveLength(2)
  })

  test("the receiver's query token: a wrong or missing token is 403", async () => {
    const { runtime, client, deliveries } = harness()
    await client.submitAnswers({ surveyId: NPS, answers: {}, accountId: "acct_1" })
    await runtime.webhooks.idle()
    const request = deliveries[0] as Request
    expect((await new WebhookReceiver("another-token").receive(request.clone())).status).toBe(403)
    const url = new URL(request.url)
    url.search = ""
    const stripped = new Request(url, {
      method: "POST",
      headers: request.headers,
      body: await request.clone().text(),
    })
    expect((await new WebhookReceiver(TOKEN).receive(stripped)).status).toBe(403)
  })

  test("an unfinished response emits responseCreated only, to webhooks that subscribe to it", async () => {
    const { deliveries, runtime, post, admin } = harness()
    const unfinished = () => post(WORKSPACE_ID, { surveyId: NPS, finished: false, data: {} })
    await unfinished()
    await runtime.webhooks.idle()
    expect(deliveries).toHaveLength(0)
    await admin("PUT", "/webhook-endpoints", [
      { url: "http://backend.local/all", events: ["responseCreated"] },
    ])
    await unfinished()
    const events = (await (await admin("GET", "/webhooks/events")).json()) as {
      events: { type: string }[]
    }
    expect(events.events.map((e) => e.type)).toEqual(["responseCreated"])
  })

  test("the widget script is a no-op that defines window.formbricks", async () => {
    const { client } = harness()
    expect(await client.loadWidget()).toBe(true)
  })

  test("namespaces by workspace id (the SDK cannot add headers); no answers in the journal", async () => {
    const { runtime, send, admin } = harness()
    await admin("PUT", "/credentials", { credentials: { [ENVIRONMENT_ID]: "worker-1" } })
    const legacy = new SurveyClient(APP, ENVIRONMENT_ID, send)
    await legacy.submitAnswers({
      surveyId: ONBOARDING,
      answers: onboardingAnswers({ first_name: "Secretname" }),
    })
    const read = async (query: string) =>
      (await (await admin("GET", `/responses${query}`)).json()) as { responses: unknown[] }
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
  test("the client submits to the node server and the webhook reaches a real sink", async () => {
    const receiver = new WebhookReceiver(TOKEN)
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
      const client = new SurveyClient(server.url, WORKSPACE_ID, (r) => fetch(r))
      await client.submitAnswers({
        surveyId: ONBOARDING,
        answers: onboardingAnswers(),
        accountId: "acct_http",
      })
      const deadline = Date.now() + 3_000
      while (receiver.completed.length < 1 && Date.now() < deadline) await Bun.sleep(25)
      expect(receiver.completed.map((c) => c.accountId)).toEqual(["acct_http"])
      expect(await client.loadWidget()).toBe(true)
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
