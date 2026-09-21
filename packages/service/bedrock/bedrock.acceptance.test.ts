import { afterEach, describe, expect, test } from "bun:test"
import { createAmazonBedrock } from "@ai-sdk/amazon-bedrock"
import { BedrockAgentCoreClient } from "@aws-sdk/client-bedrock-agentcore"
import {
  BedrockRuntimeClient,
  ConverseCommand,
  ConverseStreamCommand,
} from "@aws-sdk/client-bedrock-runtime"
import { generateText, type ModelMessage, streamText, tool } from "ai"
import { z } from "zod"
import { BEDROCK_PRESETS, DEFAULT_SOAP_NOTE, type Script } from "./src/index.js"
import { type BedrockServer, createServer } from "./src/server.js"
import {
  analyzeWithForcedTool,
  approve,
  BedrockLlmProvider,
  BedrockThrottledError,
  classifyBedrockValidationError,
  classifyIntent,
  createChatTools,
  createNovaSonicConnection,
  generateEmbedding,
  generateNote,
  invokeErxPrescreenAgent,
  isBedrockValidationError,
  isRetriableBedrockError,
  isThrottlingBedrockError,
  makorConverse,
  parseMeal,
  RxSymptomInputSchema,
  streamChatTurn,
} from "./test/consumer.js"

const CHAT_MODEL = "global.anthropic.claude-sonnet-4-6"
const HAIKU = "us.anthropic.claude-haiku-4-5-20251001-v1:0"
const HARNESS = "arn:aws:bedrock-agentcore:us-east-1:123456789012:harness/erx-prescreen"
const NOVA_PRO_ARN =
  "arn:aws:bedrock:us-east-1:123456789012:inference-profile/us.amazon.nova-pro-v1:0"
const SONIC = "amazon.nova-sonic-v1:0"

let open: BedrockServer[] = []
afterEach(async () => {
  await Promise.all(open.map((s) => s.close()))
  open = []
})

/** A served mock plus our consumer's clients pointed at it (credentials pick the namespace). */
const harness = async (accessKeyId = "AKIDACCEPTANCE") => {
  const server = await createServer()
  open.push(server)
  const admin = async (
    path: string,
    body?: unknown,
    method = body === undefined ? "GET" : "POST",
  ) => {
    const response = await fetch(`${server.url}/__admin${path}`, {
      method,
      headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    return (await response.json()) as Record<string, unknown>
  }
  const credentials = { accessKeyId, secretAccessKey: "mock-secret" }
  const client = new BedrockRuntimeClient({
    region: "us-east-1",
    endpoint: server.url,
    credentials,
  })
  const agentCore = new BedrockAgentCoreClient({
    region: "us-east-1",
    endpoint: server.url,
    credentials,
  })
  const bedrock = createAmazonBedrock({ region: "us-east-1", ...credentials, baseURL: server.url })
  const scripts = (list: Script[]) => admin("/scripts", { scripts: list }, "PUT")
  return {
    server,
    admin,
    client,
    agentCore,
    bedrock,
    scripts,
    llm: new BedrockLlmProvider(client, CHAT_MODEL, 5),
  }
}

const user = (text: string): ModelMessage[] => [{ role: "user", content: text }]

describe("S7.6 acceptance: the AI SDK chat turn", () => {
  test("streamText yields text, tool calls and the right finishReason for every stopReason", async () => {
    const { scripts, bedrock } = await harness()
    const cases: [string, Script["turns"][number], string][] = [
      ["end_turn", { text: "All good.", stopReason: "end_turn" }, "stop"],
      ["stop_sequence", { text: "Cut at the stop.", stopReason: "stop_sequence" }, "stop"],
      ["max_tokens", { text: "A long answer that gets", stopReason: "max_tokens" }, "length"],
      ["guardrail_intervened", { guardrail: true }, "content-filter"],
      ["content_filtered", { text: "", stopReason: "content_filtered" }, "content-filter"],
      [
        "tool_use",
        { toolUse: { name: "query_backend", input: { resource: "orders" } } },
        "tool-calls",
      ],
    ]
    for (const [reason, turn, finishReason] of cases) {
      await scripts([{ id: reason, match: { lastUserText: reason }, turns: [turn] }])
      const result = streamText({
        model: bedrock(CHAT_MODEL),
        messages: user(`case ${reason}`),
        // No execute: the loop stops at the tool call, so the finish is the model's.
        tools: { query_backend: tool({ inputSchema: z.object({ resource: z.string() }) }) },
        maxRetries: 0,
      })
      const parts: { type: string; [key: string]: unknown }[] = []
      for await (const part of result.fullStream) parts.push(part as never)
      expect({ reason, finish: parts.find((p) => p.type === "finish")?.finishReason }).toEqual({
        reason,
        finish: finishReason,
      })
      if (reason === "tool_use") {
        const call = parts.find((p) => p.type === "tool-call") as unknown as {
          toolName: string
          input: unknown
        }
        expect(call).toMatchObject({ toolName: "query_backend", input: { resource: "orders" } })
      } else if (reason !== "content_filtered") {
        expect(parts.some((p) => p.type === "text-delta")).toBe(true)
      }
    }
  })

  test("a script drives the report_rx_symptom approval card; approving resumes the turn", async () => {
    const { scripts, bedrock, admin } = await harness()
    // The catalog example uses {symptom, severity}; the real tool validates RxSymptomInputSchema.
    const input = {
      symptoms: [{ symptomDefinitionId: 7, severity: 3 }],
      note: "dizzy after the new dose",
    }
    expect(RxSymptomInputSchema.safeParse(input).success).toBe(true)
    await scripts([
      {
        id: "rx-symptom-approval",
        match: {
          modelId: "*sonnet*",
          lastUserText: { contains: "dizzy" },
          toolsInclude: ["report_rx_symptom"],
        },
        turns: [
          { toolUse: { name: "report_rx_symptom", input }, stopReason: "tool_use" },
          {
            expectToolResult: { name: "report_rx_symptom" },
            text: "I've flagged that for your care team.",
            chunkSize: 12,
            stopReason: "end_turn",
            usage: { inputTokens: 1200, outputTokens: 40, cacheReadInputTokens: 900 },
          },
        ],
      },
    ])
    const reported: unknown[] = []
    const tools = createChatTools(reported as never)
    const history = user("I have been feeling dizzy since the new dose")
    const first = await streamChatTurn({
      bedrock,
      modelId: CHAT_MODEL,
      systemPrompt: "You are Makor.",
      messages: history,
      tools,
      retryBaseDelayMs: 5,
    })
    expect(first.approvals).toHaveLength(1)
    expect(first.approvals[0]).toMatchObject({ toolName: "report_rx_symptom", input })
    expect(first.finishReason).toBe("tool-calls")
    expect(reported).toEqual([])

    const resumed = await streamChatTurn({
      bedrock,
      modelId: CHAT_MODEL,
      systemPrompt: "You are Makor.",
      messages: approve(history, first),
      tools,
      retryBaseDelayMs: 5,
    })
    expect(reported).toEqual([input])
    expect(resumed.text).toBe("I've flagged that for your care team.")
    expect(resumed.finishReason).toBe("stop")
    // Streamed in 12-character deltas.
    expect(resumed.parts.filter((p) => p.type === "text-delta").map((p) => p.text)).toEqual([
      "I've flagged",
      " that for yo",
      "ur care team",
      ".",
    ])
    const finish = resumed.parts.find((p) => p.type === "finish") as unknown as {
      totalUsage: { inputTokens: number; outputTokens: number }
    }
    expect(finish.totalUsage.outputTokens).toBe(40)

    const journal = (await admin("/requests")) as {
      requests: { operationId: string; ids?: Record<string, string> }[]
    }
    const scripted = journal.requests.filter((r) => r.ids?.script === "rx-symptom-approval")
    expect(scripted.map((r) => r.ids?.stopReason)).toEqual(["tool_use", "end_turn"])
    expect(scripted[0]?.ids?.flags).toContain("cachePoint")
    // Metadata only: never the member's words or the model's.
    expect(JSON.stringify(journal)).not.toContain("dizzy")
    expect(JSON.stringify(journal)).not.toContain("flagged")
  })

  test("denying the approval resumes with the denial and no tool execution", async () => {
    const { scripts, bedrock } = await harness()
    await scripts([
      {
        id: "deny",
        match: { lastUserText: "dizzy" },
        turns: [
          {
            toolUse: {
              name: "report_rx_symptom",
              input: { symptoms: [{ symptomDefinitionId: 1, severity: 1 }] },
            },
          },
          { text: "Okay, I won't send it." },
        ],
      },
    ])
    const reported: unknown[] = []
    const tools = createChatTools(reported as never)
    const history = user("dizzy again")
    const first = await streamChatTurn({
      bedrock,
      modelId: CHAT_MODEL,
      systemPrompt: "s",
      messages: history,
      tools,
      retryBaseDelayMs: 5,
    })
    const resumed = await streamChatTurn({
      bedrock,
      modelId: CHAT_MODEL,
      systemPrompt: "s",
      messages: approve(history, first, false),
      tools,
      retryBaseDelayMs: 5,
    })
    expect(reported).toEqual([])
    expect(resumed.text).toBe("Okay, I won't send it.")
  })

  test("ThrottlingException before the first chunk: surfaced to the chat turn; the SDK path retries it", async () => {
    const { bedrock, admin, llm } = await harness()
    await admin("/faults", { preset: "throttling", count: 1 })
    // Discrepancy: the backend's retry loop probes the first `fullStream` part for an error,
    // but AI SDK v6 always emits `start` first, so a pre-emission throttle is never retried
    // there — it arrives as an `error` part. Our classifiers still see a throttle.
    const turn = await streamChatTurn({
      bedrock,
      modelId: CHAT_MODEL,
      systemPrompt: "s",
      messages: user("hi"),
      tools: {},
      retryBaseDelayMs: 5,
    })
    expect(turn.parts[0]?.type).toBe("start")
    expect(turn.attempts).toBe(1)
    expect(turn.failed).toBe(true)
    const error = turn.parts.find((p) => p.type === "error")?.error
    expect(isThrottlingBedrockError(error)).toBe(true)
    expect(isRetriableBedrockError(error)).toBe(true)
    // The SDK path (BedrockLlmProvider + the AWS SDK's own standard retries) recovers.
    await admin("/faults", { preset: "throttling", count: 2 })
    expect(
      (
        await llm.converse({
          messages: [{ role: "user", content: [{ text: "hi" }] }],
          systemPrompt: "s",
        })
      ).text,
    ).toBe("OK.")
    const journal = (await admin("/requests?operationId=Converse")) as {
      requests: { status: number }[]
    }
    expect(journal.requests.map((r) => r.status)).toEqual([429, 429, 200])
    // Exhausted everywhere: 3 SDK attempts × 3 provider attempts, then our classifier says throttled.
    await admin("/faults", { preset: "throttling", count: 9 })
    const exhausted = await llm
      .converse({ messages: [{ role: "user", content: [{ text: "hi" }] }], systemPrompt: "s" })
      .catch((e: unknown) => e)
    expect(isThrottlingBedrockError(exhausted)).toBe(true)
    expect(new BedrockThrottledError(1, exhausted).retryAfterSeconds).toBe(1)
  })

  test("a mid-stream exception frame after the first chunk is surfaced, never retried", async () => {
    const { bedrock, scripts, llm } = await harness()
    await scripts([
      {
        id: "boom",
        turns: [
          {
            text: "Partial answer that dies",
            chunkSize: 8,
            fault: { type: "mid_stream_exception", afterChunks: 1 },
          },
        ],
      },
    ])
    const outcome = await streamChatTurn({
      bedrock,
      modelId: CHAT_MODEL,
      systemPrompt: "s",
      messages: user("hi"),
      tools: {},
      retryBaseDelayMs: 5,
    })
    expect(outcome.attempts).toBe(1)
    expect(outcome.text).toBe("Partial ")
    expect(outcome.failed).toBe(true)
    const error = outcome.parts.find((p) => p.type === "error")?.error as { message?: string }
    expect(error.message).toBe("The model stream encountered an error. Try your request again.")
    // The SDK path (v1 chat) throws the provider's own message.
    const events: string[] = []
    const failure = await (async () => {
      for await (const event of llm.converseStream({
        messages: [{ role: "user", content: [{ text: "hi" }] }],
        systemPrompt: "s",
      })) {
        events.push(event.type)
      }
    })().catch((e: unknown) => e)
    expect(events).toEqual(["text_delta"])
    // Discrepancy: the AWS SDK throws an exception frame as a modelled error instead of
    // yielding `event.modelStreamErrorException`, so the provider's own branch (and its
    // "Bedrock model stream error:" prefix) never runs; the classifier still retries it.
    expect((failure as Error).name).toBe("ModelStreamErrorException")
    expect(isRetriableBedrockError(failure)).toBe(true)
  })

  test("a truncated frame breaks both event-stream decoders", async () => {
    const { bedrock, admin, client } = await harness()
    await admin("/faults", { preset: "truncated_frame", count: 2 })
    const outcome = await streamChatTurn({
      bedrock,
      modelId: CHAT_MODEL,
      systemPrompt: "s",
      messages: user("hi"),
      tools: {},
      retryBaseDelayMs: 5,
    }).catch((e: unknown) => e)
    expect(String((outcome as Error).message)).toMatch(
      /Incomplete Amazon Bedrock event-stream frame/,
    )
    const response = await client.send(
      new ConverseStreamCommand({
        modelId: CHAT_MODEL,
        messages: [{ role: "user", content: [{ text: "hi" }] }],
      }),
    )
    const decoded = await (async () => {
      for await (const _ of response.stream ?? []) {
        // drain
      }
    })().catch((e: unknown) => e)
    expect(decoded).toBeInstanceOf(Error)
  })

  test("max_tokens truncation and ValidationExceptions reach our classifiers with the right kind", async () => {
    const { bedrock, admin } = await harness()
    await admin("/faults", { preset: "max_tokens", count: 1 })
    const truncated = await streamChatTurn({
      bedrock,
      modelId: CHAT_MODEL,
      systemPrompt: "s",
      messages: user("hi"),
      tools: {},
      retryBaseDelayMs: 5,
    })
    expect(truncated.finishReason).toBe("length")

    const prefill = await generateText({
      model: bedrock(CHAT_MODEL),
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "Sure," },
      ],
      maxRetries: 0,
    }).catch((e: unknown) => e)
    expect(isBedrockValidationError(prefill)).toBe(true)
    expect(isRetriableBedrockError(prefill)).toBe(false)
    expect(classifyBedrockValidationError(prefill)).toBe("assistant_prefill")

    const sampling = await generateText({
      model: bedrock("us.anthropic.claude-sonnet-4-5-20250929-v1:0"),
      prompt: "hi",
      temperature: 0.2,
      topP: 0.9,
      maxRetries: 0,
    }).catch((e: unknown) => e)
    expect(classifyBedrockValidationError(sampling)).toBe("unsupported_sampling_parameters")

    const documentOnly = await generateText({
      model: bedrock(CHAT_MODEL),
      messages: [
        {
          role: "user",
          content: [
            {
              type: "file",
              data: new Uint8Array([37, 80, 68, 70]),
              mediaType: "application/pdf",
              filename: "labs.pdf",
            },
          ],
        },
      ],
      maxRetries: 0,
    }).catch((e: unknown) => e)
    expect(classifyBedrockValidationError(documentOnly)).toBe("document_block_missing_text")

    await admin("/faults", { preset: "validation_exception", count: 1 })
    const plain = await generateText({
      model: bedrock(CHAT_MODEL),
      prompt: "hi",
      maxRetries: 0,
    }).catch((e: unknown) => e)
    expect(isBedrockValidationError(plain)).toBe(true)
    expect(isThrottlingBedrockError(plain)).toBe(false)
  })

  test("chunk pacing and latency run on the mock clock (deterministic TTFT)", async () => {
    const { bedrock, scripts, admin } = await harness()
    await admin("/clock", { freeze: true })
    await scripts([
      { id: "slow", turns: [{ text: "Paced reply", chunkSize: 6, delayMsPerChunk: 250 }] },
    ])
    const result = streamText({ model: bedrock(CHAT_MODEL), prompt: "hi", maxRetries: 0 })
    const seen: string[] = []
    const done = (async () => {
      for await (const part of result.textStream) seen.push(part)
    })()
    await Bun.sleep(60)
    expect(seen).toEqual([])
    await admin("/clock", { advance: 250 })
    await Bun.sleep(60)
    expect(seen).toEqual(["Paced "])
    await admin("/clock", { advance: 250 })
    await done
    expect(seen).toEqual(["Paced ", "reply"])

    await admin("/scripts", undefined, "DELETE")
    await admin("/faults", { preset: "latency", count: 1 })
    const late = generateText({ model: bedrock(CHAT_MODEL), prompt: "hi", maxRetries: 0 })
    let settled = false
    void late.then(() => {
      settled = true
    })
    await Bun.sleep(60)
    expect(settled).toBe(false)
    await admin("/clock", { advance: 2_000 })
    expect((await late).text).toBe("OK.")
  })

  test("a guardrail intervention carries the trace and maps to content-filter", async () => {
    const { bedrock, scripts } = await harness()
    await scripts([
      { id: "blocked", match: { lastUserText: "overdose" }, turns: [{ guardrail: true }] },
    ])
    const result = await generateText({
      model: bedrock(CHAT_MODEL),
      prompt: "how much for an overdose",
      maxRetries: 0,
      providerOptions: {
        bedrock: {
          guardrailConfig: { guardrailIdentifier: "gr-1", guardrailVersion: "1", trace: "enabled" },
        },
      },
    })
    expect(result.finishReason).toBe("content-filter")
    expect(result.text).toBe("Sorry, the model cannot answer this question.")
    const bedrockMetadata = result.providerMetadata?.bedrock as
      | { trace?: { guardrail?: { inputAssessment?: Record<string, unknown> } } }
      | undefined
    const trace = bedrockMetadata?.trace
    expect(Object.keys(trace?.guardrail?.inputAssessment ?? {})).toEqual(["gr-1"])
    const meal = await parseMeal(bedrock, HAIKU, "an overdose of sugar", {
      guardrail: { guardrailIdentifier: "gr-1", guardrailVersion: "1" },
    })
    expect(meal).toEqual({ status: "unavailable", reason: "guardrail_blocked" })
  })
})

describe("S7.6 acceptance: the SDK paths", () => {
  test("ConverseStreamCommand decodes every frame type through BedrockLlmProvider", async () => {
    const { scripts, client, llm } = await harness()
    await scripts([
      {
        id: "full",
        turns: [
          {
            reasoning: "Think first.",
            text: "Here you go.",
            toolUse: { name: "query_backend", input: { resource: "orders", limit: 3 } },
            usage: { inputTokens: 10, outputTokens: 5 },
          },
        ],
      },
    ])
    const response = await client.send(
      new ConverseStreamCommand({
        modelId: CHAT_MODEL,
        messages: [{ role: "user", content: [{ text: "orders?" }] }],
        toolConfig: {
          tools: [
            { toolSpec: { name: "query_backend", inputSchema: { json: { type: "object" } } } },
          ],
        },
      }),
    )
    const kinds: string[] = []
    let input = ""
    for await (const event of response.stream ?? []) {
      const [kind] = Object.keys(event).filter(
        (k) => (event as unknown as Record<string, unknown>)[k] !== undefined,
      )
      kinds.push(kind as string)
      if (event.contentBlockDelta?.delta?.toolUse?.input)
        input += event.contentBlockDelta.delta.toolUse.input
      if (event.metadata)
        expect(event.metadata.usage).toEqual({ inputTokens: 10, outputTokens: 5, totalTokens: 15 })
    }
    expect(new Set(kinds)).toEqual(
      new Set([
        "messageStart",
        "contentBlockDelta",
        "contentBlockStop",
        "contentBlockStart",
        "messageStop",
        "metadata",
      ]),
    )
    expect(JSON.parse(input)).toEqual({ resource: "orders", limit: 3 })

    const events = []
    for await (const event of llm.converseStream({
      messages: [{ role: "user", content: [{ text: "orders?" }] }],
      systemPrompt: "s",
      tools: [
        {
          toolSpec: {
            name: "query_backend",
            description: "read",
            inputSchema: { json: { type: "object" } },
          },
        },
      ],
    })) {
      events.push(event)
    }
    expect(events.map((e) => e.type)).toEqual([
      "text_delta",
      "tool_use_start",
      "tool_use_delta",
      "tool_use_delta",
      "tool_use_stop",
      "message_complete",
      "metadata",
    ])
    expect(events.find((e) => e.type === "message_complete")).toEqual({
      type: "message_complete",
      stopReason: "tool_use",
    })
  })

  test("Makor converse with a URL-encoded inference-profile ARN, plus outputConfig.textFormat", async () => {
    const { scripts, client, admin } = await harness()
    await scripts([
      {
        id: "draft",
        match: { modelId: "*nova-pro*", lastUserText: { regex: "^draft" } },
        turns: [{ json: { title: "Sleep", icon: "moon" } }],
      },
      {
        id: "nova",
        match: { modelId: "arn:aws:bedrock:*:inference-profile/*nova-pro*", operation: "Converse" },
        turns: [{ text: "Blueprint ready." }],
      },
    ])
    const plain = await makorConverse(client, NOVA_PRO_ARN, {
      system: "Blueprint agent",
      userText: "hello",
    })
    expect(plain).toMatchObject({
      text: "Blueprint ready.",
      stopReason: "end_turn",
      toolRequests: [],
    })
    expect(plain.requestId).toMatch(/^[0-9a-f-]{36}$/)
    const structured = await makorConverse(client, NOVA_PRO_ARN, {
      system: "Blueprint agent",
      userText: "draft a strategy",
      outputConfig: {
        textFormat: {
          type: "json_schema",
          structure: {
            jsonSchema: {
              schema: JSON.stringify({
                type: "object",
                required: ["title", "icon"],
                properties: { title: { type: "string" }, icon: { type: "string" } },
              }),
              name: "lifestyle_strategy_draft_output",
            },
          },
        },
      },
    })
    expect(JSON.parse(structured.text as string)).toEqual({ title: "Sleep", icon: "moon" })
    const journal = (await admin("/requests")) as { requests: { ids?: Record<string, string> }[] }
    expect(journal.requests.map((r) => r.ids?.modelId)).toEqual([NOVA_PRO_ARN, NOVA_PRO_ARN])
    expect(journal.requests[1]?.ids?.flags).toBe("structured:outputConfig")
  })

  test("structured output in each form our callers use: native output_config, the json tool, outputConfig, forced tools", async () => {
    const { scripts, bedrock, client, admin } = await harness()
    const ingredients = [
      { sourceText: "two eggs", name: "egg", quantity: 2, unit: "piece", prep: null },
    ]
    await scripts([
      { id: "meal", match: { lastUserText: "eggs" }, turns: [{ json: { ingredients } }] },
    ])
    for (const mode of ["outputFormat", "jsonTool"] as const) {
      expect(await parseMeal(bedrock, HAIKU, "two eggs", { structuredOutputMode: mode })).toEqual({
        status: "ok",
        ingredients: ingredients as never,
      })
    }
    // Unscripted: a schema-valid minimal object, so the parser still succeeds.
    const fallback = await parseMeal(bedrock, HAIKU, "a sandwich", {
      structuredOutputMode: "jsonTool",
    })
    expect(fallback.status).toBe("ok")
    const flags = (
      (await admin("/requests")) as { requests: { ids?: Record<string, string> }[] }
    ).requests.map((r) => r.ids?.flags)
    expect(flags).toEqual(["structured:outputFormat", "structured:tool", "structured:tool"])

    const triageSchema = {
      type: "object",
      required: ["category", "urgency"],
      properties: {
        category: { type: "string", enum: ["billing", "clinical"] },
        urgency: { type: "integer", minimum: 1, maximum: 5 },
      },
    }
    const outputSchema = z.object({
      category: z.enum(["billing", "clinical"]),
      urgency: z.number().int().min(1).max(5),
    })
    const base = {
      modelId: HAIKU,
      toolName: "record_chat_triage",
      toolDescription: "Record triage",
      toolInputJsonSchema: triageSchema,
      systemPrompt: "Triage",
      userPrompt: "chat log",
      outputSchema,
    }
    expect(await analyzeWithForcedTool(client, base)).toEqual({ category: "billing", urgency: 1 })
    await scripts([
      {
        id: "triage",
        match: { toolChoice: "record_chat_triage" },
        turns: [{ json: { category: "clinical", urgency: 4 } }],
      },
    ])
    expect(await analyzeWithForcedTool(client, base)).toEqual({ category: "clinical", urgency: 4 })
  })

  test("defaults when unscripted, each counted as unscripted: chat, classifier, scribe SOAP, Titan, harness", async () => {
    const { client, llm, agentCore, admin } = await harness()
    expect(await classifyIntent(llm, "hello there")).toEqual({
      category: "general",
      confidence: 0.9,
    })
    expect(
      (
        await llm.converse({
          messages: [{ role: "user", content: [{ text: "hi" }] }],
          systemPrompt: "s",
        })
      ).text,
    ).toBe("OK.")
    const note = await generateNote(
      client,
      "us.anthropic.claude-sonnet-4-20250514-v1:0",
      "Doctor: how are you?",
    )
    expect(note).toEqual(DEFAULT_SOAP_NOTE)
    expect(note.sections.map((s) => s.title)).toEqual([
      "Subjective",
      "Objective",
      "Assessment",
      "Plan",
    ])
    const a = await generateEmbedding(client, "chest pain after exercise")
    const b = await generateEmbedding(client, "chest pain after exercise")
    const c = await generateEmbedding(client, "something else")
    expect(a).toHaveLength(1024)
    expect(a).toEqual(b)
    expect(a).not.toEqual(c)
    expect(Math.abs(Math.hypot(...a) - 1)).toBeLessThan(1e-9)
    const prescreen = await invokeErxPrescreenAgent(agentCore, HARNESS, {
      memberId: "m-1",
      productKey: "semaglutide",
      medicationRequestId: "mr-1",
    })
    expect(prescreen?.status).toBe("eligible_for_clinician_review")
    expect(prescreen?.protocolVersion).toBe("semaglutide-mock-1")
    const stats = (await admin("/scripts")) as {
      stats: { unscripted: number; scripted: number; byFallback: Record<string, number> }
    }
    expect(stats.stats).toMatchObject({
      scripted: 0,
      unscripted: 7,
      byFallback: { classifier: 1, chat: 1, scribe: 1, titan: 3, harness: 1 },
    })
    const health = (await (await fetch(`${(await harness()).server.url}/health`)).json()) as Record<
      string,
      unknown
    >
    expect(health.status).toBe("ok")
  })

  test("a scribe script returns the SOAP JSON our EMR parses", async () => {
    const { client, scripts } = await harness()
    const soap = {
      sections: ["Subjective", "Objective", "Assessment", "Plan"].map((title) => ({
        title,
        content: `${title} text`,
      })),
      summary: "Short visit.",
    }
    await scripts([
      {
        id: "scribe",
        match: { operation: "InvokeModel", modelId: "*claude-sonnet-4-*" },
        turns: [{ text: `\`\`\`json\n${JSON.stringify(soap)}\n\`\`\`` }],
      },
    ])
    expect(
      await generateNote(client, "us.anthropic.claude-sonnet-4-20250514-v1:0", "transcript"),
    ).toEqual(soap)
  })

  test("AgentCore InvokeHarness: scripted text, a toolResult delta, and exception frames", async () => {
    const { agentCore, scripts } = await harness()
    const summary = {
      status: "needs_more_info",
      summary: "Need labs",
      narrative: "n",
      protocolVersion: "glp1-v3",
      ranAt: "2026-09-20T00:00:00.000Z",
      missingData: [{ id: "a1c", label: "HbA1c" }],
    }
    await scripts([
      {
        id: "prescreen",
        match: { operation: "InvokeHarness", lastUserText: { contains: '"product_key":"glp1"' } },
        turns: [{ text: JSON.stringify(summary), chunkSize: 20 }],
      },
    ])
    expect(
      await invokeErxPrescreenAgent(agentCore, HARNESS, { memberId: "m", productKey: "glp1" }),
    ).toMatchObject({
      status: "needs_more_info",
      protocolVersion: "glp1-v3",
      missingData: [{ id: "a1c", label: "HbA1c" }],
    })
    await scripts([
      {
        id: "tool",
        match: { operation: "InvokeHarness" },
        turns: [{ toolResult: [{ json: { ...summary, status: "not_prescreen_eligible" } }] }],
      },
    ])
    expect(
      (
        await invokeErxPrescreenAgent(agentCore, HARNESS, {
          memberId: "m",
          productKey: "tadalafil",
        })
      )?.status,
    ).toBe("not_prescreen_eligible")
    for (const exceptionType of [
      "validationException",
      "internalServerException",
      "runtimeClientError",
    ]) {
      await scripts([
        {
          id: exceptionType,
          match: { operation: "InvokeHarness" },
          turns: [
            {
              text: "partial",
              chunkSize: 3,
              fault: {
                type: "mid_stream_exception",
                exceptionType,
                message: `${exceptionType} happened`,
              },
            },
          ],
        },
      ])
      const error = await invokeErxPrescreenAgent(agentCore, HARNESS, {
        memberId: "m",
        productKey: "dhea",
      }).catch((e: unknown) => e)
      expect((error as Error).message).toBe(`${exceptionType} happened`)
    }
  })

  test("Nova Sonic over h2c: greeting, a spoken turn that calls a tool, and the answer after the tool result", async () => {
    const { client, scripts } = await harness()
    await scripts([
      {
        id: "greet",
        times: 1,
        match: { operation: "InvokeModelWithBidirectionalStream", lastUserText: "tapped Begin" },
        turns: [{ text: "Hi, I am Maker. What is your main goal?" }],
      },
      {
        id: "answer",
        match: {
          operation: "InvokeModelWithBidirectionalStream",
          toolsInclude: ["save_intake_answer"],
        },
        turns: [
          {
            userTranscript: "Better sleep",
            toolUse: {
              name: "save_intake_answer",
              input: { topic: "goal", answer: "Better sleep" },
            },
          },
          {
            expectToolResult: { name: "save_intake_answer" },
            text: "Got it. How many hours do you sleep?",
          },
        ],
      },
    ])
    const events: Record<string, Record<string, unknown>>[] = []
    let toolUse: Record<string, unknown> | undefined
    const connection = createNovaSonicConnection({
      client,
      providerModelArn: SONIC,
      onProviderEvent: (event) => {
        const payload = (event as { event: Record<string, Record<string, unknown>> }).event
        events.push(payload)
        if (payload.toolUse) toolUse = payload.toolUse
      },
    })
    await connection.startSession()
    const waitFor = async (predicate: () => boolean) => {
      const deadline = Date.now() + 5_000
      while (!predicate() && Date.now() < deadline) await Bun.sleep(10)
      expect(predicate()).toBe(true)
    }
    const texts = () =>
      events
        .filter((e) => e.textOutput && e.textOutput.role === "ASSISTANT")
        .map((e) => e.textOutput?.content)
    await waitFor(() => texts().length === 1)
    expect(texts()).toEqual(["Hi, I am Maker. What is your main goal?"])
    await connection.sendAudioInput({ audio: Buffer.alloc(3200).toString("base64") })
    await connection.sendAudioInput({ audio: Buffer.alloc(3200).toString("base64"), final: true })
    await waitFor(() => toolUse !== undefined)
    expect(toolUse).toMatchObject({
      toolName: "save_intake_answer",
      content: JSON.stringify({ topic: "goal", answer: "Better sleep" }),
    })
    expect(events.find((e) => e.textOutput?.role === "USER")?.textOutput?.content).toBe(
      "Better sleep",
    )
    await connection.sendToolResult({
      toolUseId: toolUse?.toolUseId as string,
      content: { saved: true },
    })
    await waitFor(() => texts().length === 2)
    expect(texts()[1]).toBe("Got it. How many hours do you sleep?")
    await connection.close()
    expect(connection.failure).toBeUndefined()
    const audio = events
      .filter((e) => e.audioOutput)
      .map((e) => Buffer.from(String(e.audioOutput?.content), "base64").length)
    expect(audio.reduce((a, b) => a + b, 0) % 2).toBe(0)
    expect(events.at(-1)?.completionEnd).toBeDefined()
  })
})

describe("the scripting model", () => {
  test("every match key selects the script it names", async () => {
    const { scripts, client, admin } = await harness()
    const converse = async (modelId: string, input: Record<string, unknown>) => {
      const out = await client.send(
        new ConverseCommand({
          modelId,
          messages: [{ role: "user", content: [{ text: "hello" }] }],
          ...(input as object),
        } as never),
      )
      return out.output?.message?.content
        ?.map((b) => b.text ?? (b.toolUse ? `tool:${b.toolUse.name}` : ""))
        .join("")
    }
    const systemHash = new Bun.CryptoHasher("sha256")
      .update("You are the triage bot.")
      .digest("hex")
    await scripts([
      { id: "by-call-index", match: { callIndex: 0 }, turns: [{ text: "first call" }] },
      { id: "by-system", match: { systemHash }, turns: [{ text: "system matched" }] },
      { id: "by-document", match: { hasDocument: true }, turns: [{ text: "document seen" }] },
      { id: "by-image", match: { hasImage: true }, turns: [{ text: "image seen" }] },
      {
        id: "by-tool-choice",
        match: { toolChoice: "any" },
        turns: [{ toolUse: { name: "lookup" } }],
      },
      { id: "by-tools", match: { toolsInclude: ["lookup"] }, turns: [{ text: "tools matched" }] },
      {
        id: "by-regex",
        match: { lastUserText: { regex: "^order #\\d+$" } },
        turns: [{ text: "regex matched" }],
      },
      {
        id: "by-model",
        match: { modelId: "*haiku*", operation: "Converse" },
        turns: [{ text: "haiku matched" }],
      },
      { id: "twice", times: 2, match: { lastUserText: "limited" }, turns: [{ text: "limited" }] },
    ])
    expect(await converse(CHAT_MODEL, {})).toBe("first call")
    expect(await converse(CHAT_MODEL, { system: [{ text: "You are the triage bot." }] })).toBe(
      "system matched",
    )
    expect(
      await converse(CHAT_MODEL, {
        messages: [
          {
            role: "user",
            content: [
              { text: "see" },
              { document: { format: "pdf", name: "labs", source: { bytes: new Uint8Array([1]) } } },
            ],
          },
        ],
      }),
    ).toBe("document seen")
    expect(
      await converse(CHAT_MODEL, {
        messages: [
          {
            role: "user",
            content: [
              { text: "see" },
              { image: { format: "png", source: { bytes: new Uint8Array([1]) } } },
            ],
          },
        ],
      }),
    ).toBe("image seen")
    const tools = {
      tools: [{ toolSpec: { name: "lookup", inputSchema: { json: { type: "object" } } } }],
    }
    expect(await converse(CHAT_MODEL, { toolConfig: { ...tools, toolChoice: { any: {} } } })).toBe(
      "tool:lookup",
    )
    expect(await converse(CHAT_MODEL, { toolConfig: tools })).toBe("tools matched")
    expect(
      await converse(CHAT_MODEL, {
        messages: [{ role: "user", content: [{ text: "order #42" }] }],
      }),
    ).toBe("regex matched")
    expect(await converse(HAIKU, {})).toBe("haiku matched")
    const limited = { messages: [{ role: "user" as const, content: [{ text: "limited" }] }] }
    expect([
      await converse(CHAT_MODEL, limited),
      await converse(CHAT_MODEL, limited),
      await converse(CHAT_MODEL, limited),
    ]).toEqual(["limited", "limited", "OK."])
    const stats = (await admin("/model-metrics")) as {
      byScript: Record<string, number>
      unscripted: number
    }
    expect(stats.byScript["twice"]).toBe(2)
    expect(stats.unscripted).toBe(1)
  })

  test("scripts are validated, listed, replaced, appended and deleted per namespace", async () => {
    const { admin } = await harness()
    expect(await admin("/scripts", { scripts: [{ id: "x", turns: [] }] }, "PUT")).toEqual({
      error: { type: "mockingbird_admin", message: "scripts[0].turns: a non-empty array" },
    })
    expect(
      (
        (await admin("/scripts", { scripts: [{ id: "x", turns: [{ fault: "nope" }] }] }, "PUT"))
          .error as { message: string }
      ).message,
    ).toMatch(/fault/)
    await admin("/scripts", { scripts: [{ id: "a", turns: [{ text: "a" }] }] }, "PUT")
    await admin("/scripts", { scripts: [{ id: "b", turns: [{ text: "b" }] }] }, "POST")
    expect(
      ((await admin("/scripts")) as { scripts: { id: string }[] }).scripts.map((s) => s.id),
    ).toEqual(["a", "b"])
    await admin("/scripts?id=a", undefined, "DELETE")
    expect(
      ((await admin("/scripts")) as { scripts: { id: string }[] }).scripts.map((s) => s.id),
    ).toEqual(["b"])
    expect(((await admin("/scripts?namespace=other")) as { scripts: unknown[] }).scripts).toEqual(
      [],
    )
  })

  test("every documented preset is registered", () => {
    expect(Object.keys(BEDROCK_PRESETS)).toEqual(
      expect.arrayContaining([
        "throttling",
        "mid_stream_exception",
        "validation_exception",
        "max_tokens",
        "latency",
        "truncated_frame",
      ]),
    )
  })
})
