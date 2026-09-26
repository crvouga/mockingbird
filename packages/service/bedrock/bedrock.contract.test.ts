import { describe, expect, test } from "bun:test"
import { BEDROCK_PRESETS, createRuntime } from "./src/index.js"
import { createServer } from "./src/server.js"

const API = "http://bedrock.mock"
const CHAT = "global.anthropic.claude-sonnet-4-6"

/** A SigV4-style Authorization header: only the access key id matters to the mock. */
const sigv4 = (accessKeyId: string) => ({
  authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/20260920/us-east-1/bedrock/aws4_request, SignedHeaders=host;x-amz-date, Signature=deadbeef`,
})

const converse = (text: string, headers: Record<string, string> = {}, path = "") =>
  new Request(`${API}${path}/model/${encodeURIComponent(CHAT)}/converse`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ messages: [{ role: "user", content: [{ text }] }] }),
  })

const admin = (
  path: string,
  body?: unknown,
  method = body === undefined ? "GET" : "POST",
  headers: Record<string, string> = {},
) =>
  new Request(`${API}/__admin${path}`, {
    method,
    headers: { "content-type": "application/json", ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })

const said = async (response: Response) =>
  ((await response.json()) as { output: { message: { content: { text: string }[] } } }).output
    .message.content[0]?.text

describe("the Mockingbird contract", () => {
  test("/health is open and every response carries x-mockingbird", async () => {
    const runtime = createRuntime()
    const health = await runtime.fetch(new Request(`${API}/health`))
    expect(health.status).toBe(200)
    expect(await health.json()).toMatchObject({
      status: "ok",
      service: "bedrock",
      modelCalls: { scripted: 0, unscripted: 0 },
    })
    expect(health.headers.get("x-mockingbird")).toMatch(/^bedrock@.+; ns=default$/)
    const vendor = await runtime.fetch(converse("hi"))
    expect(vendor.headers.get("x-mockingbird")).toMatch(/^bedrock@/)
    expect(vendor.headers.get("x-amzn-requestid")).toMatch(/^[0-9a-f]{8}-/)
  })

  test("namespaces isolate scripts by header, by /ns/ prefix, and by SigV4 access key id", async () => {
    const runtime = createRuntime()
    await runtime.fetch(
      admin("/scripts?namespace=a", { scripts: [{ id: "a", turns: [{ text: "from a" }] }] }, "PUT"),
    )
    await runtime.fetch(
      admin("/scripts?namespace=b", { scripts: [{ id: "b", turns: [{ text: "from b" }] }] }, "PUT"),
    )
    expect(
      await said(await runtime.fetch(converse("hi", { "x-mockingbird-namespace": "a" }))),
    ).toBe("from a")
    expect(await said(await runtime.fetch(converse("hi", {}, "/ns/b")))).toBe("from b")
    expect(await said(await runtime.fetch(converse("hi")))).toBe("OK.")
    await runtime.fetch(
      admin("/credentials", { credentials: { AKIDWORKERA: "a", AKIDWORKERB: "b" } }, "PUT"),
    )
    expect(await said(await runtime.fetch(converse("hi", sigv4("AKIDWORKERA"))))).toBe("from a")
    expect(await said(await runtime.fetch(converse("hi", sigv4("AKIDWORKERB"))))).toBe("from b")
    // Reset is per namespace, and scripts go with it.
    await runtime.fetch(admin("/reset?namespace=a", {}))
    expect(await said(await runtime.fetch(converse("hi", sigv4("AKIDWORKERA"))))).toBe("OK.")
    expect(await said(await runtime.fetch(converse("hi", sigv4("AKIDWORKERB"))))).toBe("from b")
  })

  test("presets: each documented one is listed and fires for the calling namespace only", async () => {
    const runtime = createRuntime()
    const listed = (await (await runtime.fetch(admin("/faults/presets"))).json()) as {
      presets: { name: string }[]
    }
    expect(listed.presets.map((p) => p.name).sort()).toEqual(Object.keys(BEDROCK_PRESETS).sort())
    await runtime.fetch(
      admin("/faults", { preset: "throttling", count: 1 }, "POST", {
        "x-mockingbird-namespace": "w1",
      }),
    )
    expect((await runtime.fetch(converse("hi", { "x-mockingbird-namespace": "w2" }))).status).toBe(
      200,
    )
    const throttled = await runtime.fetch(converse("hi", { "x-mockingbird-namespace": "w1" }))
    expect(throttled.status).toBe(429)
    expect(throttled.headers.get("x-amzn-errortype")).toBe(
      "ThrottlingException:http://internal.amazon.com/coral/com.amazon.bedrock/",
    )
    expect(await throttled.json()).toEqual({
      message: "Too many requests, please wait before trying again.",
    })
    expect((await runtime.fetch(converse("hi", { "x-mockingbird-namespace": "w1" }))).status).toBe(
      200,
    )
  })

  test("the journal records metadata (model, script, tools, flags, tokens) and never prompt text", async () => {
    const runtime = createRuntime()
    await runtime.fetch(
      admin(
        "/scripts",
        {
          scripts: [
            {
              id: "secret-script",
              match: { lastUserText: "PHI" },
              turns: [{ text: "Sensitive reply about PHI" }],
            },
          ],
        },
        "PUT",
      ),
    )
    const request = new Request(`${API}/model/${encodeURIComponent(CHAT)}/converse`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        system: [{ text: "SYSTEM PROMPT TEXT" }, { cachePoint: { type: "default" } }],
        messages: [{ role: "user", content: [{ text: "My PHI: DOB 1970-01-01" }] }],
        toolConfig: {
          tools: [
            { toolSpec: { name: "query_backend", inputSchema: { json: { type: "object" } } } },
          ],
        },
        guardrailConfig: { guardrailIdentifier: "g", guardrailVersion: "1" },
      }),
    })
    expect((await runtime.fetch(request)).status).toBe(200)
    const journal = (await (await runtime.fetch(admin("/requests"))).json()) as {
      requests: { operationId: string; ids: Record<string, string> }[]
    }
    expect(journal.requests[0]).toMatchObject({
      operationId: "Converse",
      ids: {
        modelId: CHAT,
        script: "secret-script",
        tools: "query_backend",
        flags: "cachePoint,guardrail",
        stopReason: "end_turn",
      },
    })
    const text = JSON.stringify(journal)
    for (const secret of ["DOB", "1970", "SYSTEM PROMPT", "Sensitive reply"])
      expect(text).not.toContain(secret)
    expect(Number(journal.requests[0]?.ids.inputTokens)).toBeGreaterThan(0)
  })

  test("settings change the unscripted answer and the default chunking", async () => {
    const runtime = createRuntime()
    await runtime.fetch(admin("/settings", { defaultText: "Mock says hi." }, "PUT"))
    expect(await said(await runtime.fetch(converse("hi")))).toBe("Mock says hi.")
    const bad = await runtime.fetch(admin("/settings", { nope: 1 }, "PUT"))
    expect(bad.status).toBe(400)
    expect(await bad.json()).toEqual({
      error: { type: "mockingbird_admin", message: "unknown setting nope" },
    })
  })
})

describe("served over HTTP", () => {
  test("plain fetch (HTTP/1.1) against the node server, and snapshots restore scripts", async () => {
    const server = await createServer({
      scripts: [
        { id: "boot", match: { lastUserText: "boot" }, turns: [{ text: "Loaded at boot." }] },
      ],
    })
    try {
      const call = (text: string) =>
        fetch(`${server.url}/model/${encodeURIComponent(CHAT)}/converse`, {
          method: "POST",
          headers: { "content-type": "application/json", ...sigv4("AKIDHTTP") },
          body: JSON.stringify({ messages: [{ role: "user", content: [{ text }] }] }),
        })
      const booted = await call("boot please")
      expect(booted.headers.get("x-mockingbird")).toMatch(/^bedrock@/)
      expect(await said(booted)).toBe("Loaded at boot.")
      const snapshot = (await (
        await fetch(`${server.url}/__admin/snapshots`, { method: "POST" })
      ).json()) as { id: string }
      await fetch(`${server.url}/__admin/scripts`, { method: "DELETE" })
      expect(await said(await call("boot please"))).toBe("OK.")
      await fetch(`${server.url}/__admin/snapshots/${snapshot.id}/restore`, { method: "POST" })
      expect(await said(await call("boot please"))).toBe("Loaded at boot.")
      const unmatched = await fetch(`${server.url}/model/x/unknown-op`, { method: "POST" })
      expect(unmatched.status).toBe(404)
      const metrics = (await (await fetch(`${server.url}/__admin/metrics`)).json()) as {
        unmatched: { path: string }[]
      }
      expect(metrics.unmatched.map((u) => u.path)).toContain("/model/x/unknown-op")
    } finally {
      await server.close()
    }
  })
})
