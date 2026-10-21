/**
 * Request checks, script match keys and the opt-in controls added for the agent-reported
 * issues (#516 to #523). Behaviours marked "best guess" are not oracle-verified; see README.
 */
import { describe, expect, test } from "bun:test"
import { BEDROCK_PRESETS, createRuntime, type Script } from "./src/index.js"

// biome-ignore lint/suspicious/noExplicitAny: assertions read loose response JSON
type Loose = Record<string, any>

const CLAUDE = "us.anthropic.claude-sonnet-4-6"

const harness = () => {
  const runtime = createRuntime()
  const send = (
    path: string,
    method: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ) =>
    runtime.fetch(
      new Request(`http://emulator${path}`, {
        method,
        headers: { "content-type": "application/json", ...headers },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    )
  const admin = async (
    path: string,
    body?: unknown,
    method = body === undefined ? "GET" : "PUT",
  ) => {
    const response = await send(`/__admin${path}`, method, body)
    return { status: response.status, body: (await response.json()) as Loose }
  }
  const converse = async (body: unknown, modelId = CLAUDE, operation = "converse") => {
    const response = await send(`/model/${encodeURIComponent(modelId)}/${operation}`, "POST", body)
    const type = response.headers.get("x-amzn-errortype")
    // Event-stream bodies are not JSON; only errors and Converse answers are read.
    const raw = await response.text()
    const json = (raw.startsWith("{") ? JSON.parse(raw) : {}) as Loose
    return {
      status: response.status,
      type,
      message: json.message as string | undefined,
      text: json.output?.message?.content?.[0]?.text as string | undefined,
    }
  }
  const say = (text: string, extra: Record<string, unknown> = {}) =>
    converse({ messages: [{ role: "user", content: [{ text }] }], ...extra })
  const put = (scripts: Script[]) => admin("/scripts", { scripts })
  return { runtime, send, admin, converse, say, put }
}

describe("#516 unknown script match keys are rejected", () => {
  test("a misspelled or unsupported match key answers 400 and stores nothing", async () => {
    const { admin, put, say } = harness()
    for (const key of ["lastUserTxt", "schemaName"]) {
      const response = await put([
        { id: "typo", match: { [key]: "weather" } as never, turns: [{ text: "scripted answer" }] },
      ])
      expect(response.status).toBe(400)
      expect(response.body.error.message).toBe(
        `scripts[0].match.${key}: unknown match field (one of modelId, operation, lastUserText, systemHash, systemText, jsonSchemaName, toolsInclude, toolChoice, hasDocument, hasImage, callIndex)`,
      )
    }
    expect((await admin("/scripts")).body.scripts).toEqual([])
    expect((await say("tell me a joke")).text).toBe("OK.")
  })

  test("POST validates the same way, and malformed criteria are rejected, not ignored", async () => {
    const { admin } = harness()
    const post = (match: unknown) =>
      admin("/scripts", { scripts: [{ id: "x", match, turns: [{ text: "x" }] }] }, "POST")
    expect((await post({ lastUserText: { contain: "x" } })).body.error.message).toMatch(
      /match\.lastUserText\.contain: unknown text match field/,
    )
    expect((await post({ lastUserText: { regex: "(" } })).body.error.message).toMatch(
      /regular expression/,
    )
    expect((await post({ lastUserText: { regex: "x", flags: "zz" } })).status).toBe(400)
    expect((await post({ hasDocument: "yes" })).body.error.message).toMatch(/hasDocument: boolean/)
    expect((await post({ callIndex: -1 })).status).toBe(400)
    expect((await post({ modelId: 3 })).status).toBe(400)
    expect((await post({ lastUserText: "ok", systemText: { contains: "x" } })).status).toBe(200)
  })
})

describe("#520 script match on the system prompt text", () => {
  const converseWith = (system: unknown[] | undefined, text = "hi") => ({
    messages: [{ role: "user", content: [{ text }] }],
    ...(system ? { system } : {}),
  })

  test("a string is a case-insensitive contains over the joined text blocks, cachePoints skipped", async () => {
    const { put, converse } = harness()
    await put([
      { id: "cardio", match: { systemText: "CARDIO" }, turns: [{ text: "cardio agent" }] },
    ])
    const system = [
      { text: "Shared member context" },
      { cachePoint: { type: "default" } },
      { text: "You are the cardiovascular agent" },
    ]
    expect((await converse(converseWith(system))).text).toBe("cardio agent")
    expect((await converse(converseWith([{ text: "You are the sleep agent" }]))).text).toBe("OK.")
  })

  test("{regex, flags} matches by regular expression", async () => {
    const { put, converse } = harness()
    await put([
      {
        id: "agents",
        match: { systemText: { regex: "^You are the (sleep|stress) agent", flags: "m" } },
        turns: [{ text: "matched" }],
      },
    ])
    const system = [{ text: "context" }, { text: "You are the stress agent" }]
    expect((await converse(converseWith(system))).text).toBe("matched")
    expect((await converse(converseWith([{ text: "You are the cardio agent" }]))).text).toBe("OK.")
  })

  test("systemText and lastUserText must both match", async () => {
    const { put, converse } = harness()
    await put([
      {
        id: "both",
        match: { systemText: "cardio", lastUserText: "pulse" },
        turns: [{ text: "both" }],
      },
    ])
    const system = [{ text: "cardio agent" }]
    expect((await converse(converseWith(system, "my pulse"))).text).toBe("both")
    expect((await converse(converseWith(system, "my sleep"))).text).toBe("OK.")
    expect((await converse(converseWith([{ text: "sleep agent" }], "my pulse"))).text).toBe("OK.")
  })

  test("a call with no system prompt never matches, even for an empty criterion", async () => {
    const { put, converse } = harness()
    await put([
      { id: "a", match: { systemText: "cardio" }, turns: [{ text: "a" }] },
      { id: "b", match: { systemText: "" }, turns: [{ text: "b" }] },
    ])
    expect((await converse(converseWith(undefined))).text).toBe("OK.")
  })

  test("ConverseStream and InvokeModel match the same way; the journal keeps no prompt text", async () => {
    const { put, converse, send, admin } = harness()
    await put([{ id: "cardio", match: { systemText: "cardio" }, turns: [{ text: "scripted" }] }])
    const stream = await converse(
      converseWith([{ text: "cardio agent" }]),
      CLAUDE,
      "converse-stream",
    )
    expect(stream.status).toBe(200)
    for (const system of ["the cardio agent", [{ type: "text", text: "the cardio agent" }]]) {
      const invoke = await send(`/model/${CLAUDE}/invoke`, "POST", {
        anthropic_version: "bedrock-2023-05-31",
        max_tokens: 100,
        system,
        messages: [{ role: "user", content: "hi" }],
      })
      const body = (await invoke.json()) as { content: { text: string }[] }
      expect(body.content[0]?.text).toBe("scripted")
    }
    const journal = JSON.stringify((await admin("/requests")).body)
    expect(journal).toContain("cardio") // the script id
    expect(journal).not.toContain("the cardio agent")
  })
})

describe("#521 script match on the outputConfig jsonSchema name", () => {
  const structured = (name: string | undefined, text = "go") => ({
    messages: [{ role: "user", content: [{ text }] }],
    outputConfig: {
      textFormat: {
        type: "json_schema",
        structure: {
          jsonSchema: {
            schema: JSON.stringify({
              type: "object",
              properties: { a: { type: "string" } },
              required: ["a"],
              additionalProperties: false,
            }),
            ...(name ? { name } : {}),
          },
        },
      },
    },
  })

  test("a string is a case-insensitive equality; regex and contains also work", async () => {
    const { put, converse } = harness()
    await put([
      {
        id: "exact",
        match: { jsonSchemaName: "Bloodwork_Strategist_Output" },
        turns: [{ json: { a: "exact" } }],
      },
      {
        id: "regex",
        match: { jsonSchemaName: { regex: "_output$" } },
        turns: [{ json: { a: "regex" } }],
      },
      {
        id: "sub",
        match: { jsonSchemaName: { contains: "sleep" } },
        turns: [{ json: { a: "sub" } }],
      },
    ])
    expect((await converse(structured("bloodwork_strategist_output"))).text).toBe('{"a":"exact"}')
    expect((await converse(structured("sleep_agent_output"))).text).toBe('{"a":"regex"}')
    expect((await converse(structured("sleep_notes"))).text).toBe('{"a":"sub"}')
    // equality, not contains: a longer name does not match the string criterion
    expect((await converse(structured("bloodwork_strategist_output_v2"))).text).toBe('{"a":""}')
  })

  test("a call without an outputConfig name does not match", async () => {
    const { put, converse, say } = harness()
    await put([
      { id: "named", match: { jsonSchemaName: { regex: "" } }, turns: [{ text: "named" }] },
    ])
    expect((await say("hi")).text).toBe("OK.")
    expect((await converse(structured(undefined))).text).toBe('{"a":""}')
  })

  test("parallel calls are each answered by the script for their own schema name", async () => {
    const { put, converse } = harness()
    await put([
      { id: "a", match: { jsonSchemaName: "a_output" }, turns: [{ json: { a: "from a" } }] },
      { id: "b", match: { jsonSchemaName: "b_output" }, turns: [{ json: { a: "from b" } }] },
    ])
    const names = ["b_output", "a_output", "b_output", "a_output", "b_output"]
    const answers = await Promise.all(names.map((name) => converse(structured(name))))
    expect(answers.map((r) => r.text)).toEqual(names.map((name) => `{"a":"from ${name[0]}"}`))
  })

  test("ConverseStream matches the same way", async () => {
    const { put, converse } = harness()
    await put([{ id: "a", match: { jsonSchemaName: "a_output" }, turns: [{ json: { a: "x" } }] }])
    const response = await converse(structured("a_output"), CLAUDE, "converse-stream")
    expect(response.status).toBe(200)
  })

  test("the journal records the script id, not the schema", async () => {
    const { put, converse, admin } = harness()
    await put([{ id: "a", match: { jsonSchemaName: "a_output" }, turns: [{ json: { a: "x" } }] }])
    await converse(structured("a_output"))
    const journal = JSON.stringify((await admin("/requests")).body)
    expect(journal).toContain('"script":"a"')
    expect(journal).not.toContain("a_output")
    expect(journal).not.toContain("additionalProperties")
  })
})

describe("#522 opt-in lexical Titan embeddings", () => {
  const TITAN = "amazon.titan-embed-text-v2:0"
  const embed = async (
    h: ReturnType<typeof harness>,
    inputText: string,
    extra: Record<string, unknown> = {},
  ) => {
    const response = await h.send(`/model/${TITAN}/invoke`, "POST", {
      inputText,
      dimensions: 1024,
      normalize: true,
      ...extra,
    })
    return ((await response.json()) as { embedding: number[] }).embedding
  }
  const cosine = (a: number[], b: number[]) =>
    a.reduce((sum, v, i) => sum + v * (b[i] as number), 0)
  const A = "Member prefers magnesium glycinate at night"

  test("the default stays SHA-256: near-identical texts are unrelated", async () => {
    const h = harness()
    expect(Math.abs(cosine(await embed(h, A), await embed(h, `${A}.`)))).toBeLessThan(0.3)
    expect((await h.admin("/settings")).body.embeddingMode).toBe("sha256")
  })

  test("lexical mode is deterministic across calls, namespaces and runtimes", async () => {
    const h = harness()
    expect((await h.admin("/settings", { embeddingMode: "lexical" })).status).toBe(200)
    const first = await embed(h, A)
    expect(await embed(h, A)).toEqual(first)
    const other = harness()
    await other.admin("/settings", { embeddingMode: "lexical" })
    expect(await embed(other, A)).toEqual(first)
    expect((await h.admin("/settings")).body.embeddingMode).toBe("lexical")
  })

  test("case, punctuation and whitespace differences stay at similarity >= 0.9", async () => {
    const h = harness()
    await h.admin("/settings", { embeddingMode: "lexical" })
    const base = await embed(h, A)
    for (const variant of [
      `${A}.`,
      A.toUpperCase(),
      `  ${A.replaceAll(" ", "   ")}!! `,
      A.replaceAll(" ", ", "),
    ]) {
      expect(cosine(base, await embed(h, variant))).toBeGreaterThanOrEqual(0.9)
    }
  })

  test("shared words score clearly above unrelated texts, which stay below 0.3", async () => {
    const h = harness()
    await h.admin("/settings", { embeddingMode: "lexical" })
    const base = await embed(h, A)
    const related = cosine(
      base,
      await embed(h, "The member likes taking magnesium glycinate in the evening"),
    )
    const unrelated = cosine(base, await embed(h, "Quarterly invoice for hosting"))
    expect(related).toBeGreaterThan(0.3)
    expect(unrelated).toBeLessThan(0.3)
    expect(related).toBeGreaterThan(unrelated + 0.2)
  })

  test("the vector has `dimensions` entries and unit norm", async () => {
    const h = harness()
    await h.admin("/settings", { embeddingMode: "lexical" })
    for (const dimensions of [256, 512, 1024]) {
      const vector = await embed(h, A, { dimensions })
      expect(vector).toHaveLength(dimensions)
      expect(Math.sqrt(cosine(vector, vector))).toBeCloseTo(1, 6)
    }
    const symbols = await embed(h, "!!! ???")
    expect(Math.sqrt(cosine(symbols, symbols))).toBeCloseTo(1, 6)
  })

  test("an unknown embedding mode is rejected", async () => {
    const { admin } = harness()
    expect((await admin("/settings", { embeddingMode: "semantic" })).status).toBe(400)
  })
})

describe("#523 resource_not_found fault", () => {
  test("a scripted turn answers 404 ResourceNotFoundException on Converse", async () => {
    const { put, say } = harness()
    await put([{ id: "gone", turns: [{ fault: "resource_not_found" }] }])
    const response = await say("hi")
    expect(response.status).toBe(404)
    expect(response.type).toBe(
      "ResourceNotFoundException:http://internal.amazon.com/coral/com.amazon.bedrock/",
    )
    expect(response.message).toBe(
      "The specified resource ARN was not found. Check the ARN and try again.",
    )
  })

  test("the preset fails the next `count` calls, then the call succeeds", async () => {
    const { admin, say } = harness()
    expect(Object.keys(BEDROCK_PRESETS)).toContain("resource_not_found")
    expect(
      (await admin("/faults/presets")).body.presets.map((preset: { name: string }) => preset.name),
    ).toContain("resource_not_found")
    await admin("/faults", { preset: "resource_not_found", count: 2 }, "POST")
    expect((await say("1")).status).toBe(404)
    expect((await say("2")).status).toBe(404)
    expect((await say("3")).text).toBe("OK.")
  })

  test("ConverseStream and InvokeModel fail with a plain HTTP error before any frame", async () => {
    const { admin, converse, send } = harness()
    await admin("/faults", { preset: "resource_not_found", count: 2 }, "POST")
    const stream = await converse(
      { messages: [{ role: "user", content: [{ text: "hi" }] }] },
      CLAUDE,
      "converse-stream",
    )
    expect(stream.status).toBe(404)
    expect(stream.type).toStartWith("ResourceNotFoundException")
    const invoke = await send(`/model/${CLAUDE}/invoke`, "POST", {
      anthropic_version: "bedrock-2023-05-31",
      max_tokens: 10,
      messages: [{ role: "user", content: "hi" }],
    })
    expect(invoke.status).toBe(404)
  })
})

describe("#517 structured output schemas Bedrock rejects (best guess, not oracle-verified)", () => {
  const object = (properties: object, extra: object = {}) => ({
    type: "object",
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
    ...extra,
  })
  const withSchema = (schema: unknown) => ({
    messages: [{ role: "user", content: [{ text: "go" }] }],
    outputConfig: {
      textFormat: {
        type: "json_schema",
        structure: {
          jsonSchema: {
            schema: typeof schema === "string" ? schema : JSON.stringify(schema),
            name: "probe_output",
          },
        },
      },
    },
  })

  const rejected: [string, unknown, RegExp][] = [
    [
      "oneOf",
      object({ a: { oneOf: [{ type: "string" }, { type: "number" }] } }),
      /^Schema type 'oneOf' is not supported$/,
    ],
    [
      "additionalProperties: true",
      object({ a: { type: "string" } }, { additionalProperties: true }),
      /'additionalProperties: true' is not supported\. Please set 'additionalProperties' to false/,
    ],
    [
      "open dict",
      object({ m: { type: "object", additionalProperties: { type: "string" } } }),
      /'additionalProperties: \{"type":"string"\}' is not supported/,
    ],
    ["minimum", object({ a: { type: "integer", minimum: 1 } }), /'minimum' is not supported/],
    ["maximum", object({ a: { type: "integer", maximum: 1 } }), /'maximum' is not supported/],
    [
      "multipleOf",
      object({ a: { type: "integer", multipleOf: 2 } }),
      /'multipleOf' is not supported/,
    ],
    ["minLength", object({ a: { type: "string", minLength: 3 } }), /'minLength' is not supported/],
    ["maxLength", object({ a: { type: "string", maxLength: 3 } }), /'maxLength' is not supported/],
    [
      "minItems 2",
      object({ a: { type: "array", items: { type: "string" }, minItems: 2 } }),
      /minItems/,
    ],
    [
      "enum with a union type",
      object({ a: { type: ["string", "null"], enum: ["x", "y"] } }),
      /string-only 'enum'/,
    ],
    ["external $ref", object({ a: { $ref: "https://example.com/schema.json" } }), /External \$ref/],
    [
      "recursive $ref",
      {
        type: "object",
        properties: { child: { $ref: "#/$defs/node" } },
        required: ["child"],
        additionalProperties: false,
        $defs: {
          node: object({ next: { $ref: "#/$defs/node" } }),
        },
      },
      /Recursive schemas are not supported/,
    ],
    ["a schema that is not JSON", "not json", /not a valid JSON object/],
    ["a JSON array", "[1]", /not a valid JSON object/],
  ]

  for (const [name, schema, message] of rejected) {
    test(`${name} answers 400 ValidationException`, async () => {
      const { converse } = harness()
      for (const operation of ["converse", "converse-stream"]) {
        const response = await converse(withSchema(schema), CLAUDE, operation)
        expect(response.status).toBe(400)
        expect(response.type).toStartWith("ValidationException:")
        expect(response.message).toMatch(message)
      }
    })
  }

  test("a rejected request does not reach a script and is not counted as a model call", async () => {
    const { put, converse, admin } = harness()
    await put([{ id: "any", turns: [{ json: { a: "x" } }] }])
    await converse(withSchema(object({ a: { type: "string", minLength: 1 } })))
    expect((await admin("/scripts")).body.stats.calls).toBe(0)
  })

  test("supported constructs still pass: array minItems 0/1, internal $ref, anyOf, enum, additionalProperties omitted", async () => {
    const { converse } = harness()
    const ok: unknown[] = [
      object({ a: { type: "array", items: { type: "string" }, minItems: 1 } }),
      object({ a: { anyOf: [{ type: "string" }, { type: "null" }] } }),
      object({
        a: { type: "string", enum: ["x", "y"] },
        b: { type: "string", format: "date-time" },
      }),
      { type: "object", properties: { a: { type: "string" } }, required: ["a"] },
      {
        type: "object",
        properties: { item: { $ref: "#/$defs/item" }, other: { $ref: "#/$defs/item" } },
        required: ["item", "other"],
        additionalProperties: false,
        $defs: { item: object({ minimum: { type: "string" } }) },
      },
    ]
    for (const schema of ok) {
      const response = await converse(withSchema(schema))
      expect({ schema, status: response.status, message: response.message }).toMatchObject({
        status: 200,
      })
    }
  })
})

describe("#518 document names (best guess for the message, not oracle-verified)", () => {
  const withDocument = (name: string) => ({
    messages: [
      {
        role: "user",
        content: [
          { text: "read this" },
          { document: { format: "pdf", name, source: { bytes: btoa("%PDF-1.4 fake") } } },
        ],
      },
    ],
  })

  for (const name of [
    "Lab Results Sep 1, 2026",
    "labs_export",
    "report.pdf",
    "it's",
    "em—dash",
    "two  spaces",
    "tab\there  ",
    "x".repeat(201),
  ]) {
    test(`${JSON.stringify(name.length > 40 ? `x*${name.length}` : name)} answers 400 ValidationException`, async () => {
      const { converse } = harness()
      const response = await converse(withDocument(name))
      expect(response.status).toBe(400)
      expect(response.type).toStartWith("ValidationException:")
      expect(response.message).toContain(
        "The document file name can only contain alphanumeric characters",
      )
    })
  }

  test("legal names pass, including hyphens, parentheses, brackets, single spaces and 200 characters", async () => {
    const { converse } = harness()
    for (const name of [
      "Lab Results (Sep 1 2026) [final]",
      "a-b",
      "x".repeat(200),
      "Report 2026",
    ]) {
      expect((await converse(withDocument(name))).status).toBe(200)
    }
  })

  test("the check also applies to ConverseStream", async () => {
    const { converse } = harness()
    expect((await converse(withDocument("labs_export"), CLAUDE, "converse-stream")).status).toBe(
      400,
    )
  })
})

describe("#519 cachePoint checks (best guess, not oracle-verified)", () => {
  const cache = { cachePoint: { type: "default" } }
  const doc = { document: { format: "txt", name: "notes", source: { bytes: btoa("hello") } } }

  test("a cachePoint directly after a document block answers 400", async () => {
    const { converse } = harness()
    const response = await converse({
      messages: [{ role: "user", content: [{ text: "read" }, doc, cache] }],
    })
    expect(response.status).toBe(400)
    expect(response.type).toStartWith("ValidationException:")
    expect(response.message).toMatch(/cachePoint cannot directly follow a document block/)
    // after text that follows the document it is fine
    expect(
      (
        await converse({
          messages: [{ role: "user", content: [doc, { text: "read" }, cache] }],
        })
      ).status,
    ).toBe(200)
  })

  test("a cachePoint on a model without prompt caching answers 400, in every field", async () => {
    const { converse } = harness()
    const hi = { role: "user", content: [{ text: "hi" }] }
    for (const modelId of [
      "anthropic.claude-3-haiku-20240307-v1:0",
      "amazon.titan-text-lite-v1",
      "meta.llama3-1-8b-instruct-v1:0",
    ]) {
      const bodies = [
        { messages: [{ role: "user", content: [{ text: "hi" }, cache] }] },
        { messages: [hi], system: [{ text: "sys" }, cache] },
        {
          messages: [hi],
          toolConfig: {
            tools: [{ toolSpec: { name: "t", inputSchema: { json: { type: "object" } } } }, cache],
          },
        },
      ]
      for (const body of bodies) {
        const response = await converse(body, modelId)
        expect(response.status).toBe(400)
        expect(response.message).toMatch(/does not support prompt caching/)
      }
      // without a cachePoint the same model still answers
      expect((await converse({ messages: [hi] }, modelId)).status).toBe(200)
    }
  })

  test("supported families pass in plain, regional-profile and ARN forms", async () => {
    const { converse } = harness()
    const body = { messages: [{ role: "user", content: [{ text: "hi" }, cache] }] }
    for (const modelId of [
      "anthropic.claude-sonnet-4-5-20250929-v1:0",
      "global.anthropic.claude-sonnet-4-6",
      "us.anthropic.claude-haiku-4-5-20251001-v1:0",
      "anthropic.claude-3-7-sonnet-20250219-v1:0",
      "amazon.nova-pro-v1:0",
      "arn:aws:bedrock:us-east-1:123456789012:inference-profile/us.amazon.nova-lite-v1:0",
    ]) {
      expect({ modelId, status: (await converse(body, modelId)).status }).toEqual({
        modelId,
        status: 200,
      })
    }
  })

  test("validatePromptCaching: false turns the model check off", async () => {
    const { admin, converse } = harness()
    const body = { messages: [{ role: "user", content: [{ text: "hi" }, cache] }] }
    expect((await converse(body, "amazon.titan-text-lite-v1")).status).toBe(400)
    expect((await admin("/settings", { validatePromptCaching: false })).status).toBe(200)
    expect((await converse(body, "amazon.titan-text-lite-v1")).status).toBe(200)
    expect((await admin("/settings", { validatePromptCaching: "no" })).status).toBe(400)
  })
})
