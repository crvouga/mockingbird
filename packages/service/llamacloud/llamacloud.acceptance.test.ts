import { describe, expect, test } from "bun:test"
import { fcParameters } from "@crvouga/mockingbird-testing"
import fc from "fast-check"
import { createRuntime, LLAMACLOUD_PRESETS, rank } from "./src/index.js"
import { createServer } from "./src/server.js"
import { LlamaCloudKnowledgeAdapter, PythonLlamaCloudClient } from "./test/consumer.js"

const params = fcParameters(process.env)
const HOST = "http://llamacloud.mock"
/** The backend's `LLAMACLOUD_BASE_URL` (seam G-L1) includes `/api/v1`. */
const API = `${HOST}/api/v1`
const INDEX = "acme-member-kb-v1"

const harness = (options: Parameters<typeof createRuntime>[0] = {}) => {
  const runtime = createRuntime(options)
  const send = (request: Request) => runtime.fetch(request)
  const adapter = (
    config: { apiKey?: string | null; indexName?: string | null; project?: string } = {},
  ) =>
    new LlamaCloudKnowledgeAdapter(
      API,
      {
        apiKey: config.apiKey === undefined ? "llx-backend" : config.apiKey,
        indexName: config.indexName === undefined ? INDEX : config.indexName,
        ...(config.project ? { projectName: config.project } : {}),
      },
      send,
      () => runtime.clock.now(),
    )
  const admin = (path: string, body?: unknown, method = body === undefined ? "GET" : "PUT") =>
    runtime.fetch(
      new Request(`${HOST}/__admin${path}`, {
        method,
        headers: { "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    )
  return { runtime, adapter, admin, send }
}

const seedArticles = async (adapter: LlamaCloudKnowledgeAdapter) => {
  await adapter.createArticle({
    title: "Vitamin D basics",
    content: "Vitamin D supports bone health and immune function.",
    contentType: "supplement",
    sourceUrl: "https://example.com/vitamin-d",
  })
  await adapter.createArticle({
    title: "Magnesium and sleep",
    content: "Magnesium glycinate may improve sleep quality.",
    contentType: "supplement",
    sourceUrl: null,
  })
  await adapter.createArticle({
    title: "What is ApoB?",
    content: "ApoB counts atherogenic particles; high ApoB raises cardiovascular risk.",
    contentType: "biomarker",
    sourceUrl: null,
  })
}

describe("S14 acceptance: the backend knowledge adapter against the mock", () => {
  test("without a key or index, everything returns empty and nothing is sent", async () => {
    const { runtime, adapter } = harness()
    for (const unconfigured of [adapter({ apiKey: null }), adapter({ indexName: null })]) {
      expect(await unconfigured.search("vitamin d")).toEqual([])
      expect(await unconfigured.listDocuments()).toEqual([])
      expect(await unconfigured.listArticles()).toEqual([])
      expect(await unconfigured.getArticle("x")).toBeNull()
      await expect(unconfigured.upsertMarkdown("a", "A", "b")).rejects.toThrow(
        "llamacloud_not_configured",
      )
    }
    expect(runtime.journal.list({ namespace: "default" })).toHaveLength(0)
  })

  test("the pipeline is found by project_name + index name, once, and cached", async () => {
    const { runtime, adapter } = harness()
    const client = adapter()
    const id = await client.resolvePipelineId()
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/)
    await client.search("anything")
    await client.listDocuments()
    const ops = runtime.journal.list({ namespace: "default" }).map((e) => e.operationId)
    expect(ops.filter((op) => op === "SearchPipelines")).toHaveLength(1)
  })

  test("an unknown index or project logs and degrades to empty", async () => {
    const { adapter } = harness()
    const wrongIndex = adapter({ indexName: "nope" })
    expect(await wrongIndex.search("vitamin d")).toEqual([])
    expect(wrongIndex.logs.at(-1)).toContain('pipeline "nope" not found in project "Default"')
    const wrongProject = adapter({ project: "Other" })
    expect(await wrongProject.listDocuments()).toEqual([])
  })

  test("EMR chatbot-admin CRUD: create, list (filtered), get, update, delete", async () => {
    const { adapter } = harness()
    const client = adapter()
    await seedArticles(client)
    const articles = await client.listArticles()
    expect(articles.map((a) => a.id)).toEqual([
      "vitamin-d-basics",
      "magnesium-and-sleep",
      "what-is-apob",
    ])
    expect(articles[0]).toEqual({
      id: "vitamin-d-basics",
      title: "Vitamin D basics",
      content: "Vitamin D supports bone health and immune function.",
      contentType: "supplement",
      sourceUrl: "https://example.com/vitamin-d",
      updatedAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT/),
    })
    expect((await client.listArticles("biomarker")).map((a) => a.id)).toEqual(["what-is-apob"])
    const updated = await client.updateArticle("what-is-apob", { content: "ApoB, updated." })
    expect(updated.title).toBe("What is ApoB?")
    expect((await client.getArticle("what-is-apob"))?.content).toBe("ApoB, updated.")
    await expect(client.updateArticle("missing", { content: "x" })).rejects.toThrow(
      "article_not_found",
    )
    await client.deleteDocument("magnesium-and-sleep")
    expect(await client.getArticle("magnesium-and-sleep")).toBeNull()
    expect((await client.listDocuments()).map((d) => [d.id, d.fileName])).toEqual([
      ["vitamin-d-basics", "vitamin-d-basics.md"],
      ["what-is-apob", "what-is-apob.md"],
    ])
    // DELETE of a missing document is a non-2xx: logged, not thrown.
    await client.deleteDocument("magnesium-and-sleep")
    expect(client.logs.at(-1)).toContain("returned 404")
  })

  test("upsert by slug is idempotent across sync runs (same id replaces in place)", async () => {
    const { adapter } = harness()
    const client = adapter()
    await client.upsertMarkdown("faq-shipping", "Shipping", "We ship in 3 days.")
    await client.upsertMarkdown("faq-returns", "Returns", "Returns within 30 days.")
    await client.upsertMarkdown("faq-shipping", "Shipping", "We ship in 2 days.")
    const docs = await client.listDocuments()
    expect(docs.map((d) => d.id)).toEqual(["faq-shipping", "faq-returns"])
    expect(docs[0]?.sizeChars).toBe("# Shipping\n\nWe ship in 2 days.".length)
  })

  test("search_health_knowledge: term-overlap ranking, titles from file_name, document_id as sourceId", async () => {
    const { adapter } = harness()
    const client = adapter()
    await seedArticles(client)
    const hits = await client.search("does magnesium improve sleep?")
    expect(hits[0]).toEqual({
      title: "magnesium-and-sleep",
      content: "# Magnesium and sleep\n\nMagnesium glycinate may improve sleep quality.",
      score: 1,
      sourceId: "magnesium-and-sleep",
    })
    expect(await client.search("zzz unrelated")).toEqual([])
    // Same query, same documents: same answer.
    expect(await client.search("vitamin d immune")).toEqual(await client.search("vitamin d immune"))
    expect(await client.search("health", 1)).toHaveLength(1)
  })

  test("scripted retrieval: PUT /__admin/retrieval answers matching queries verbatim", async () => {
    const { adapter, admin } = harness()
    const client = adapter()
    await seedArticles(client)
    const rule = {
      match: { contains: "cholesterol" },
      nodes: [
        {
          text: "LDL is one lipid marker.",
          score: 0.91,
          metadata: { file_name: "lipids.pdf", document_id: "doc-lipids" },
        },
        { text: "Second node.", metadata: { file_name: "other.txt" } },
      ],
    }
    expect((await admin("/retrieval", rule)).status).toBe(200)
    expect(await client.search("What is CHOLESTEROL?")).toEqual([
      { title: "lipids", content: "LDL is one lipid marker.", score: 0.91, sourceId: "doc-lipids" },
      { title: "other", content: "Second node.", score: 0.9, sourceId: undefined },
    ])
    expect(await client.search("cholesterol", 1)).toHaveLength(1)
    // Rules scoped to another pipeline do not apply; unmatched queries still rank documents.
    await admin("/retrieval", { match: { contains: "vitamin", pipeline: "another" }, nodes: [] })
    expect((await client.search("vitamin d"))[0]?.sourceId).toBe("vitamin-d-basics")
    // Replace all rules, then clear them.
    await admin("/retrieval", { rules: [{ match: {}, nodes: [{ text: "catch-all" }] }] })
    expect((await client.search("anything at all"))[0]?.content).toBe("catch-all")
    expect((await admin("/retrieval", undefined, "DELETE")).status).toBe(200)
    expect(await client.search("anything at all")).toEqual([])
    expect((await admin("/retrieval", { nodes: "nope" })).status).toBe(400)
  })

  test("non-2xx is logged and returns null: unauthorized, rate limited, server error, wrong key", async () => {
    for (const preset of ["unauthorized", "rate_limited", "server_error"]) {
      const { runtime, adapter } = harness()
      runtime.applyPreset(preset)
      const client = adapter()
      expect(await client.search("vitamin")).toEqual([])
      expect(client.logs.at(-2)).toMatch(
        /^error: LlamaCloud GET \/pipelines\?project_name=Default returned (401|429|500)/,
      )
    }
    const { admin, adapter } = harness()
    await admin("/settings", { apiKeys: ["llx-right"] })
    const wrong = adapter({ apiKey: "llx-wrong" })
    expect(await wrong.listDocuments()).toEqual([])
    expect(wrong.logs.at(-2)).toContain('returned 401: {"detail":"Invalid API key"}')
    expect(await adapter({ apiKey: "llx-right" }).resolvePipelineId()).not.toBeNull()
  })

  test("presets our code branches on: index_missing, retrieval_empty, documents_unexpected_shape", async () => {
    const a = harness()
    a.runtime.applyPreset("index_missing", "default", { count: 1 })
    const first = a.adapter()
    expect(await first.resolvePipelineId()).toBeNull()
    expect(await first.resolvePipelineId()).not.toBeNull()

    const b = harness()
    const client = b.adapter()
    await seedArticles(client)
    b.runtime.applyPreset("retrieval_empty", "default", { count: 1 })
    expect(await client.search("vitamin")).toEqual([])
    expect(await client.search("vitamin")).not.toEqual([])
    b.runtime.applyPreset("documents_unexpected_shape", "default", { count: 1 })
    expect(await client.listArticles()).toEqual([])

    expect(Object.keys(LLAMACLOUD_PRESETS)).toEqual(
      expect.arrayContaining([
        "index_missing",
        "retrieval_empty",
        "slow_retrieval",
        "server_error",
      ]),
    )
    const c = harness()
    c.runtime.applyPreset("slow_retrieval", "default", { latencyMs: 30 })
    const slow = c.adapter()
    await slow.resolvePipelineId()
    const started = performance.now()
    await slow.search("x")
    expect(performance.now() - started).toBeGreaterThanOrEqual(25)
  })

  test("namespaces by API key isolate parallel workers; the journal holds no text", async () => {
    const { runtime, admin, adapter } = harness()
    await admin("/credentials", { credentials: { "llx-worker-a": "a", "llx-worker-b": "b" } })
    const a = adapter({ apiKey: "llx-worker-a" })
    const b = adapter({ apiKey: "llx-worker-b" })
    await a.upsertMarkdown("secret-slug", "Private title", "sensitive body text")
    expect((await a.listDocuments()).map((d) => d.id)).toEqual(["secret-slug"])
    expect(await b.listDocuments()).toEqual([])
    await a.search("sensitive query words")
    const journal = await (await admin("/requests?namespace=a")).text()
    expect(journal).toContain("UpsertBatchPipelineDocuments")
    expect(journal).not.toContain("sensitive")
    expect(journal).not.toContain("Private title")
    // /ns/<name> also selects a namespace (for a base URL that cannot carry headers).
    const viaPrefix = new LlamaCloudKnowledgeAdapter(
      `${HOST}/ns/a/api/v1`,
      { apiKey: "llx-other", indexName: INDEX },
      (r) => runtime.fetch(r),
    )
    expect((await viaPrefix.listDocuments()).map((d) => d.id)).toEqual(["secret-slug"])
  })

  test("admin can add pipelines in other projects; reset restores the seed", async () => {
    const { admin, adapter, runtime } = harness()
    expect((await admin("/pipelines", { name: "faq-v2", projectName: "Support" })).status).toBe(200)
    expect(
      await adapter({ indexName: "faq-v2", project: "Support" }).resolvePipelineId(),
    ).not.toBeNull()
    await adapter().upsertMarkdown("x", "X", "y")
    await runtime.reset()
    const listed = (await (await admin("/pipelines")).json()) as { pipelines: { name: string }[] }
    expect(listed.pipelines.map((p) => p.name)).toEqual([INDEX])
    expect(await adapter().listDocuments()).toEqual([])
  })
})

describe("S14 acceptance: the Python chat SDK path (llama_cloud_services wire sequence)", () => {
  test("LlamaCloudIndex + as_retriever + aretrieve: project lookup, pipeline lookup, re-resolve by id, retrieve", async () => {
    const { adapter, send } = harness()
    await seedArticles(adapter())
    const python = new PythonLlamaCloudClient(
      HOST,
      { indexName: INDEX, apiKey: "llx-python", projectName: "Default", denseTopK: 2 },
      send,
    )
    const result = await python.retrieve("ApoB cardiovascular risk")
    expect(python.initializationError).toBeNull()
    expect(python.calls).toEqual([
      "GET /api/v1/projects",
      "GET /api/v1/pipelines",
      `GET /api/v1/pipelines/${await adapter().resolvePipelineId()}`,
      expect.stringMatching(/^GET \/api\/v1\/projects\/[0-9a-f-]{36}$/),
      `POST /api/v1/pipelines/${await adapter().resolvePipelineId()}/retrieve`,
    ])
    expect(result.sources[0]).toMatchObject({
      title: "What is ApoB?",
      source_id: "what-is-apob_0",
      score: 1,
    })
    expect(result.total_retrieved).toBeLessThanOrEqual(2)
  })

  test("the Python client's default project name 'default' does not match 'Default': retrieval degrades to empty", async () => {
    const { send } = harness()
    const python = new PythonLlamaCloudClient(HOST, { indexName: INDEX, apiKey: "k" }, send)
    expect(await python.retrieve("anything")).toEqual({
      query: "anything",
      sources: [],
      total_retrieved: 0,
    })
    expect(python.initializationError).toBe("No project found with name default")
  })
})

describe("ranking properties", () => {
  test("scores lie in (0, 1], are sorted, and never exceed top-k", () => {
    const docs = ["alpha beta", "beta gamma", "gamma delta", "delta alpha beta"].map((text, i) => ({
      pipeline_id: "p",
      id: `d${i}`,
      text,
      metadata: {},
      excluded_embed_metadata_keys: [],
      excluded_llm_metadata_keys: [],
      page_positions: null,
    }))
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom("alpha", "beta", "gamma", "delta", "omega"), {
          minLength: 1,
          maxLength: 5,
        }),
        fc.integer({ min: 1, max: 5 }),
        (words, k) => {
          const ranked = rank(words.join(" "), docs, k)
          expect(ranked.length).toBeLessThanOrEqual(k)
          for (const [i, row] of ranked.entries()) {
            expect(row.score).toBeGreaterThan(0)
            expect(row.score).toBeLessThanOrEqual(1)
            if (i > 0) expect(row.score).toBeLessThanOrEqual(ranked[i - 1]?.score as number)
          }
        },
      ),
      { ...params, numRuns: params.numRuns ?? 100 },
    )
  })
})

describe("served over HTTP", () => {
  test("the backend adapter works against the node server with plain fetch", async () => {
    const server = await createServer()
    try {
      const client = new LlamaCloudKnowledgeAdapter(
        `${server.url}/api/v1`,
        { apiKey: "llx-http", indexName: INDEX },
        (r) => fetch(r),
      )
      await client.upsertMarkdown("omega-3", "Omega-3", "Fish oil provides EPA and DHA.")
      expect((await client.search("fish oil"))[0]?.sourceId).toBe("omega-3")
      const health = await fetch(`${server.url}/health`)
      expect(health.headers.get("x-mockingbird")).toMatch(/^llamacloud@/)
      expect(((await health.json()) as { status: string }).status).toBe("ok")
    } finally {
      await server.close()
    }
  })
})
