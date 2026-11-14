/**
 * Bots (#752). The server runs a Bot's deployed JavaScript (fhir/operations/execute.ts,
 * bots/execute.ts and the Bot branch of workers/subscription.ts in Medplum v5.1.37); the
 * emulator runs the suite's own `bots` handler in its place, with the same routing, checks and
 * response rules around it.
 */
import { describe, expect, test } from "bun:test"
import { MedplumClient, OperationOutcomeError } from "@medplum/core"
import type { Bot, Patient, Project, ProjectMembership, Subscription } from "@medplum/fhirtypes"
import {
  DEFAULT_CLIENT_ID,
  DEFAULT_CLIENT_SECRET,
  DEFAULT_PROJECT_ID,
  MedplumAPI,
  type MedplumAPIOptions,
  type MedplumBotContext,
} from "./src/index.js"

const BASE = "http://localhost:8103/"
const IDENTIFIER = { system: "https://example.org/bots", value: "echo" }

type Call = { bot: Bot; input: unknown; context: MedplumBotContext }

const clientFor = (api: MedplumAPI) =>
  new MedplumClient({
    baseUrl: BASE,
    fetch: (url: string, init?: RequestInit) => api.fetch(new Request(url, init)),
  })

const setup = async (
  handler: MedplumAPIOptions["bots"] = (_bot, input) => ({ echo: input }),
  options: { features?: Project["features"]; membership?: boolean } = {},
) => {
  const calls: Call[] = []
  const api = new MedplumAPI({
    baseUrl: BASE,
    project: { features: options.features ?? ["bots"] },
    bots: async (bot, input, context) => {
      calls.push({ bot, input, context })
      return handler?.(bot, input, context)
    },
  })
  const bot = await api.putResource<Bot>({
    resourceType: "Bot",
    name: "echo",
    identifier: [IDENTIFIER],
  })
  if (options.membership !== false) {
    await api.putResource<ProjectMembership>({
      resourceType: "ProjectMembership",
      project: { reference: `Project/${DEFAULT_PROJECT_ID}` },
      user: { reference: `Bot/${bot.id}` },
      profile: { reference: `Bot/${bot.id}` },
    })
  }
  const medplum = clientFor(api)
  await medplum.startClientLogin(DEFAULT_CLIENT_ID, DEFAULT_CLIENT_SECRET)
  return { api, bot, medplum, calls }
}

const raw = (api: MedplumAPI, medplum: MedplumClient, path: string, init: RequestInit = {}) =>
  api.fetch(
    new Request(`${BASE}fhir/R4/${path}`, {
      ...init,
      headers: { authorization: `Bearer ${medplum.getAccessToken()}`, ...init.headers },
    }),
  )

describe("Bot/$execute", () => {
  test("runs the suite's handler with the input, and answers its return value", async () => {
    const { bot, medplum, calls } = await setup()
    const output = await medplum.executeBot(bot.id as string, { hello: "world" })
    expect(output).toEqual({ echo: { hello: "world" } })
    expect(calls).toHaveLength(1)
    expect(calls[0]?.bot).toMatchObject({ resourceType: "Bot", id: bot.id, name: "echo" })
    expect(calls[0]?.context).toMatchObject({
      contentType: "application/fhir+json",
      requester: { reference: `ClientApplication/${DEFAULT_CLIENT_ID}` },
      runAs: { profile: { reference: `Bot/${bot.id}` } },
      secrets: {},
    })
    expect(calls[0]?.context.subscription).toBeUndefined()
  })

  test("finds the bot by identifier", async () => {
    const { medplum, calls } = await setup()
    expect(await medplum.executeBot(IDENTIFIER, { n: 1 })).toEqual({ echo: { n: 1 } })
    expect(calls).toHaveLength(1)
    const missing = medplum.executeBot({ system: IDENTIFIER.system, value: "nope" }, {})
    await expect(missing).rejects.toThrow("Not found")
  })

  test("GET passes the query string as the input", async () => {
    const { api, bot, medplum } = await setup()
    const response = await raw(api, medplum, `Bot/${bot.id}/$execute?a=1&b=2`)
    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8")
    expect(await response.json()).toEqual({ echo: { a: "1", b: "2" } })
  })

  test("a text body is mirrored back as text", async () => {
    const { api, bot, medplum } = await setup((_bot, input) => `got ${input}`)
    const response = await raw(api, medplum, `Bot/${bot.id}/$execute`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "MSH|^~\\&|",
    })
    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8")
    expect(await response.text()).toBe("got MSH|^~\\&|")
  })

  test("a returned resource is sent as FHIR, and no return value is All OK", async () => {
    const patient: Patient = { resourceType: "Patient", id: "p1", active: true }
    const resource = await setup(() => patient)
    expect(await resource.medplum.executeBot(resource.bot.id as string, {})).toEqual(patient)
    const nothing = await setup(() => undefined)
    const outcome = await nothing.medplum.executeBot(nothing.bot.id as string, {})
    expect(outcome).toMatchObject({ resourceType: "OperationOutcome", id: "ok" })
  })

  test("a throwing handler is a 400 with its message", async () => {
    const { api, bot, medplum } = await setup(() => {
      throw new Error("bot exploded")
    })
    const response = await raw(api, medplum, `Bot/${bot.id}/$execute`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    })
    expect(response.status).toBe(400)
    const body = (await response.json()) as { issue: { details: { text: string } }[] }
    expect(body.issue[0]?.details.text).toBe("bot exploded")
  })

  test("a returned error OperationOutcome is sent with its status", async () => {
    const { bot, medplum } = await setup(() => ({
      resourceType: "OperationOutcome",
      issue: [{ severity: "error", code: "forbidden", details: { text: "Not today" } }],
    }))
    const error = await medplum.executeBot(bot.id as string, {}).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(OperationOutcomeError)
    expect((error as OperationOutcomeError).outcome.issue[0]?.details?.text).toBe("Not today")
  })

  test("refuses to run when the project lacks the bots feature", async () => {
    const { bot, medplum, calls } = await setup(undefined, { features: [] })
    await expect(medplum.executeBot(bot.id as string, {})).rejects.toThrow("Bots not enabled")
    expect(calls).toHaveLength(0)
  })

  test("without a bots handler it answers an explicit emulator limitation", async () => {
    const api = new MedplumAPI({ baseUrl: BASE, project: { features: ["bots"] } })
    const bot = await api.putResource<Bot>({ resourceType: "Bot", name: "inert" })
    const medplum = clientFor(api)
    await medplum.startClientLogin(DEFAULT_CLIENT_ID, DEFAULT_CLIENT_SECRET)
    await expect(medplum.executeBot(bot.id as string, {})).rejects.toThrow(
      "Bot execution is not emulated: pass a `bots` handler to the emulator",
    )
  })

  test("the handler can call back into the emulator as the bot", async () => {
    const holder: { api?: MedplumAPI } = {}
    const { api, bot, medplum } = await setup(async (_bot, input, context) => {
      const asBot = new MedplumClient({
        baseUrl: context.baseUrl,
        accessToken: context.accessToken,
        fetch: (url: string, init?: RequestInit) =>
          (holder.api as MedplumAPI).fetch(new Request(url, init)),
      })
      return asBot.createResource<Patient>({
        resourceType: "Patient",
        name: [{ family: (input as { family: string }).family }],
      })
    })
    holder.api = api
    const created = (await medplum.executeBot(bot.id as string, { family: "Hopper" })) as Patient
    expect(created).toMatchObject({ resourceType: "Patient", name: [{ family: "Hopper" }] })
    const stored = await medplum.readResource("Patient", created.id as string, {
      headers: { "X-Medplum": "extended" },
    })
    expect(stored.meta?.author).toMatchObject({ reference: `Bot/${bot.id}` })
  })

  test("X-Medplum-On-Behalf-Of makes the member the requester", async () => {
    const { api, bot, medplum, calls } = await setup()
    const member = await api.addUser({ email: "dr@example.org", password: "long-password" })
    await medplum.executeBot(bot.id as string, {}, undefined, {
      headers: { "X-Medplum-On-Behalf-Of": `Practitioner/${member.profile.id}` },
    })
    expect(calls[0]?.context.requester).toMatchObject({
      reference: `Practitioner/${member.profile.id}`,
    })
  })
})

describe("Bot subscriptions", () => {
  const subscribe = (medplum: MedplumClient, bot: Bot) =>
    medplum.createResource<Subscription>({
      resourceType: "Subscription",
      status: "active",
      reason: "Run the bot",
      criteria: "Patient",
      channel: { type: "rest-hook", endpoint: `Bot/${bot.id}` },
    })

  test("a matching write runs the bot with the resource", async () => {
    const { bot, medplum, calls } = await setup()
    const subscription = await subscribe(medplum, bot)
    const patient = await medplum.createResource<Patient>({ resourceType: "Patient" })
    expect(calls).toHaveLength(1)
    expect(calls[0]?.input).toMatchObject({ resourceType: "Patient", id: patient.id })
    expect(calls[0]?.context).toMatchObject({
      contentType: "application/fhir+json",
      interaction: "create",
      requester: { reference: `ClientApplication/${DEFAULT_CLIENT_ID}` },
      subscription: { id: subscription.id },
      headers: expect.objectContaining({
        "X-Medplum-Subscription": subscription.id,
        "X-Medplum-Interaction": "create",
      }),
    })
    await medplum.deleteResource("Patient", patient.id as string)
    expect(calls).toHaveLength(2)
    expect(calls[1]?.context.interaction).toBe("delete")
    expect(calls[1]?.input).toMatchObject({
      deletedResource: { resourceType: "Patient", id: patient.id },
    })
  })

  test("a bot with no project membership never runs, as on the server", async () => {
    const { bot, medplum, calls } = await setup(undefined, { membership: false })
    await subscribe(medplum, bot)
    await medplum.createResource<Patient>({ resourceType: "Patient" })
    expect(calls).toHaveLength(0)
  })

  test("a failing bot does not fail the write", async () => {
    const { bot, medplum, calls } = await setup(() => {
      throw new Error("bot exploded")
    })
    await subscribe(medplum, bot)
    const patient = await medplum.createResource<Patient>({ resourceType: "Patient" })
    expect(patient.id).toEqual(expect.any(String))
    expect(calls).toHaveLength(1)
  })
})
