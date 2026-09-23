import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { connect } from "node:http2"
import { createAmazonBedrock } from "@ai-sdk/amazon-bedrock"
import { BedrockAgentCoreClient, InvokeHarnessCommand } from "@aws-sdk/client-bedrock-agentcore"
import {
  BedrockRuntimeClient,
  ConverseCommand,
  ConverseStreamCommand,
  InvokeModelCommand,
  InvokeModelWithBidirectionalStreamCommand,
} from "@aws-sdk/client-bedrock-runtime"
import { EventStreamCodec } from "@smithy/eventstream-codec"
import { generateText, Output, streamText } from "ai"
import { z } from "zod"
import { decodeMessage, encodeMessage, FrameReader } from "./src/index.js"
import { type BedrockServer, createServer } from "./src/server.js"

const CHAT = "global.anthropic.claude-sonnet-4-6"
const toUtf8 = (bytes: Uint8Array) => new TextDecoder().decode(bytes)
const fromUtf8 = (text: string) => new TextEncoder().encode(text)
const smithy = new EventStreamCodec(toUtf8, fromUtf8)

let server: BedrockServer
const saved: Record<string, string | undefined> = {}
const ENV = [
  "AWS_ENDPOINT_URL_BEDROCK_RUNTIME",
  "AWS_ENDPOINT_URL_BEDROCK_AGENTCORE",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_REGION",
]

beforeAll(async () => {
  server = await createServer()
  for (const key of ENV) saved[key] = process.env[key]
  // The seam our stack uses: no code change, just the SDKs' endpoint environment variables.
  process.env.AWS_ENDPOINT_URL_BEDROCK_RUNTIME = server.url
  process.env.AWS_ENDPOINT_URL_BEDROCK_AGENTCORE = server.url
  process.env.AWS_ACCESS_KEY_ID = "AKIDSDKDROPIN"
  process.env.AWS_SECRET_ACCESS_KEY = "mock-secret"
  process.env.AWS_REGION = "us-east-1"
})

afterAll(async () => {
  for (const key of ENV) {
    if (saved[key] === undefined) delete process.env[key]
    else process.env[key] = saved[key]
  }
  await server.close()
})

const putScripts = (scripts: unknown[]) =>
  fetch(`${server.url}/__admin/scripts`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ scripts }),
  })

describe("@aws-sdk/client-bedrock-runtime@3.1132.0 (default NodeHttp2Handler → h2c)", () => {
  test("ConverseCommand and ConverseStreamCommand via AWS_ENDPOINT_URL_BEDROCK_RUNTIME", async () => {
    await putScripts([
      {
        id: "sdk",
        match: { lastUserText: "sdk" },
        turns: [{ text: "Hello from the mock.", chunkSize: 5 }],
      },
    ])
    const client = new BedrockRuntimeClient({})
    const out = await client.send(
      new ConverseCommand({
        modelId: CHAT,
        messages: [{ role: "user", content: [{ text: "sdk" }] }],
      }),
    )
    expect(out.output?.message?.content?.[0]?.text).toBe("Hello from the mock.")
    expect(out.stopReason).toBe("end_turn")
    expect(out.$metadata.httpStatusCode).toBe(200)
    const stream = await client.send(
      new ConverseStreamCommand({
        modelId: CHAT,
        messages: [{ role: "user", content: [{ text: "sdk" }] }],
      }),
    )
    let text = ""
    for await (const event of stream.stream ?? [])
      text += event.contentBlockDelta?.delta?.text ?? ""
    expect(text).toBe("Hello from the mock.")
  })

  test("InvokeModel: Titan v2 is 1024-d and deterministic; an Anthropic body returns a Messages response", async () => {
    const client = new BedrockRuntimeClient({})
    const embed = async (inputText: string, dimensions = 1024) =>
      JSON.parse(
        new TextDecoder().decode(
          (
            await client.send(
              new InvokeModelCommand({
                modelId: "amazon.titan-embed-text-v2:0",
                contentType: "application/json",
                accept: "application/json",
                body: JSON.stringify({ inputText, dimensions, normalize: true }),
              }),
            )
          ).body,
        ),
      ) as { embedding: number[]; inputTextTokenCount: number }
    const a = await embed("same text")
    expect(a.embedding).toHaveLength(1024)
    expect((await embed("same text")).embedding).toEqual(a.embedding)
    expect((await embed("same text", 256)).embedding).toHaveLength(256)
    const bad = await client
      .send(
        new InvokeModelCommand({
          modelId: "amazon.titan-embed-text-v2:0",
          contentType: "application/json",
          body: JSON.stringify({ inputText: "x", dimensions: 3 }),
        }),
      )
      .catch((e: unknown) => e)
    expect((bad as Error).name).toBe("ValidationException")
    const messages = await client.send(
      new InvokeModelCommand({
        modelId: "us.anthropic.claude-sonnet-4-20250514-v1:0",
        contentType: "application/json",
        body: JSON.stringify({
          anthropic_version: "bedrock-2023-05-31",
          max_tokens: 4096,
          messages: [{ role: "user", content: "hi" }],
        }),
      }),
    )
    const body = JSON.parse(new TextDecoder().decode(messages.body)) as {
      type: string
      stop_reason: string
      content: { text: string }[]
    }
    expect(body.type).toBe("message")
    expect(body.stop_reason).toBe("end_turn")
    expect(JSON.parse(body.content[0]?.text as string).sections).toHaveLength(4)
  })

  test("InvokeModelWithBidirectionalStream round trip over h2c (Nova Sonic)", async () => {
    await putScripts([
      {
        id: "sonic",
        match: { operation: "InvokeModelWithBidirectionalStream" },
        turns: [{ text: "Hi there." }],
      },
    ])
    const client = new BedrockRuntimeClient({})
    const enc = new TextEncoder()
    const events = [
      { sessionStart: { inferenceConfiguration: { maxTokens: 256 } } },
      { promptStart: { promptName: "p" } },
      {
        contentStart: {
          promptName: "p",
          contentName: "t",
          type: "TEXT",
          role: "USER",
          interactive: true,
        },
      },
      { textInput: { promptName: "p", contentName: "t", content: "hello" } },
      { contentEnd: { promptName: "p", contentName: "t" } },
    ]
    let release!: () => void
    const answered = new Promise<void>((resolve) => {
      release = resolve
    })
    const body = (async function* () {
      for (const event of events) yield { chunk: { bytes: enc.encode(JSON.stringify({ event })) } }
      await answered
      yield { chunk: { bytes: enc.encode(JSON.stringify({ event: { sessionEnd: {} } })) } }
    })()
    const response = await client.send(
      new InvokeModelWithBidirectionalStreamCommand({ modelId: "amazon.nova-sonic-v1:0", body }),
    )
    const kinds: string[] = []
    for await (const output of response.body ?? []) {
      const event = (
        JSON.parse(new TextDecoder().decode(output.chunk?.bytes)) as {
          event: Record<string, unknown>
        }
      ).event
      kinds.push(Object.keys(event)[0] as string)
      if (event.usageEvent) release()
    }
    expect(kinds[0]).toBe("completionStart")
    expect(kinds).toContain("textOutput")
    expect(kinds).toContain("audioOutput")
    expect(kinds.at(-1)).toBe("completionEnd")
  })

  test("SDK errors carry the modelled exception name the classifiers key on", async () => {
    const client = new BedrockRuntimeClient({ maxAttempts: 1 })
    for (const [preset, name, status] of [
      ["throttling", "ThrottlingException", 429],
      ["validation_exception", "ValidationException", 400],
      ["access_denied", "AccessDeniedException", 403],
      ["model_timeout", "ModelTimeoutException", 408],
      ["service_unavailable", "ServiceUnavailableException", 503],
      ["internal_server", "InternalServerException", 500],
    ] as const) {
      await fetch(`${server.url}/__admin/faults`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ preset, count: 1 }),
      })
      const error = (await client
        .send(
          new ConverseCommand({
            modelId: CHAT,
            messages: [{ role: "user", content: [{ text: "x" }] }],
          }),
        )
        .catch((e: unknown) => e)) as Error & { $metadata: { httpStatusCode: number } }
      expect({ name: error.name, status: error.$metadata.httpStatusCode }).toEqual({ name, status })
      await fetch(`${server.url}/__admin/faults`, { method: "DELETE" })
    }
  })
})

describe("@aws-sdk/client-bedrock-agentcore@3.1074.0", () => {
  test("InvokeHarnessCommand via AWS_ENDPOINT_URL_BEDROCK_AGENTCORE", async () => {
    const client = new BedrockAgentCoreClient({})
    const response = await client.send(
      new InvokeHarnessCommand({
        harnessArn: "arn:aws:bedrock-agentcore:us-east-1:123456789012:harness/erx-prescreen",
        runtimeSessionId: `erx-prescreen-${"0".repeat(36)}`,
        runtimeUserId: "member-1",
        messages: [
          {
            role: "user",
            content: [
              { text: JSON.stringify({ member_id: "member-1", product_key: "tirzepatide" }) },
            ],
          },
        ],
      }),
    )
    const seen: string[] = []
    let text = ""
    for await (const event of response.stream ?? []) {
      seen.push(
        Object.keys(event).find(
          (k) => (event as unknown as Record<string, unknown>)[k] !== undefined,
        ) as string,
      )
      text += event.contentBlockDelta?.delta?.text ?? ""
    }
    expect(seen).toEqual(
      expect.arrayContaining([
        "messageStart",
        "contentBlockDelta",
        "contentBlockStop",
        "messageStop",
        "metadata",
      ]),
    )
    expect(JSON.parse(text)).toMatchObject({
      status: "eligible_for_clinician_review",
      protocolVersion: "tirzepatide-mock-1",
    })
  })
})

describe("@ai-sdk/amazon-bedrock@4.0.176 + ai@6.0.283", () => {
  test("createAmazonBedrock() resolves AWS_ENDPOINT_URL_BEDROCK_RUNTIME; streamText and structured output work", async () => {
    await putScripts([
      {
        id: "ai",
        match: { lastUserText: "ai sdk" },
        turns: [{ text: "Streamed via the AI SDK.", chunkSize: 4 }],
      },
      { id: "obj", match: { lastUserText: "object" }, turns: [{ json: { answer: 42 } }] },
    ])
    const bedrock = createAmazonBedrock({
      region: "us-east-1",
      accessKeyId: "AKIDSDKDROPIN",
      secretAccessKey: "mock-secret",
    })
    const result = streamText({ model: bedrock(CHAT), prompt: "ai sdk", maxRetries: 0 })
    let text = ""
    for await (const part of result.textStream) text += part
    expect(text).toBe("Streamed via the AI SDK.")
    expect(await result.finishReason).toBe("stop")
    for (const structuredOutputMode of ["outputFormat", "jsonTool"] as const) {
      const { output } = await generateText({
        model: bedrock(CHAT),
        prompt: "object please",
        output: Output.object({ schema: z.object({ answer: z.number() }) }),
        providerOptions: { bedrock: { structuredOutputMode } },
        maxRetries: 0,
      })
      expect(output).toEqual({ answer: 42 })
    }
  })
})

describe("event-stream framing is byte-exact with @smithy/eventstream-codec", () => {
  test("frames we encode decode with smithy, and smithy's decode with ours", () => {
    const headers = {
      ":event-type": "contentBlockDelta",
      ":content-type": "application/json",
      ":message-type": "event",
    }
    const ours = encodeMessage({ headers, body: '{"delta":{"text":"hi"}}' })
    const decoded = smithy.decode(ours)
    expect(decoded.headers[":event-type"]).toEqual({ type: "string", value: "contentBlockDelta" })
    expect(toUtf8(decoded.body)).toBe('{"delta":{"text":"hi"}}')
    const theirs = smithy.encode({
      headers: {
        ":date": { type: "timestamp", value: new Date(1_700_000_000_000) },
        ":chunk-signature": { type: "binary", value: new Uint8Array([1, 2, 3]) },
        flag: { type: "boolean", value: true },
        n: { type: "integer", value: 7 },
      },
      body: ours,
    })
    const back = decodeMessage(theirs)
    expect(back.headers[":date"]).toEqual({ type: "timestamp", value: new Date(1_700_000_000_000) })
    expect(back.headers.flag).toEqual({ type: "boolean", value: true })
    expect(decodeMessage(back.body).headers[":event-type"]).toEqual({
      type: "string",
      value: "contentBlockDelta",
    })
    expect(Buffer.from(encodeMessage({ headers, body: '{"delta":{"text":"hi"}}' }))).toEqual(
      Buffer.from(
        smithy.encode({
          headers: Object.fromEntries(
            Object.entries(headers).map(([k, v]) => [k, { type: "string" as const, value: v }]),
          ),
          body: fromUtf8('{"delta":{"text":"hi"}}'),
        }),
      ),
    )
  })

  test("a ConverseStream body is a sequence of frames smithy accepts, byte for byte", async () => {
    const response = await fetch(
      `${server.url}/model/${encodeURIComponent(CHAT)}/converse-stream`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messages: [{ role: "user", content: [{ text: "frames" }] }] }),
      },
    )
    expect(response.headers.get("content-type")).toBe("application/vnd.amazon.eventstream")
    const bytes = new Uint8Array(await response.arrayBuffer())
    const reader = new FrameReader()
    const frames = reader.push(bytes)
    expect(reader.pending).toBe(0)
    let at = 0
    for (const frame of frames) {
      const length = new DataView(bytes.buffer, at).getUint32(0, false)
      expect(smithy.decode(bytes.subarray(at, at + length)).headers[":event-type"]?.value).toBe(
        frame.headers[":event-type"]?.value as string,
      )
      at += length
    }
    expect(at).toBe(bytes.length)
  })

  test("the same port speaks h2c prior knowledge to a raw HTTP/2 client", async () => {
    const session = connect(server.url)
    const request = session.request({ ":method": "GET", ":path": "/health" })
    const status = await new Promise<number>((resolve) =>
      request.on("response", (headers) => resolve(Number(headers[":status"]))),
    )
    let body = ""
    for await (const chunk of request) body += chunk
    session.close()
    expect(status).toBe(200)
    expect(JSON.parse(body).service).toBe("bedrock")
  })
})
