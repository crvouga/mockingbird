import { describe, expect, test } from "bun:test"
import { createClock } from "@crvouga/mockingbird-service"
import { createRuntime, DEFAULT_DATABASES, type OAuthCode } from "./src/index.js"
import { createServer } from "./src/server.js"
import { client, pageMarkdown } from "./test/consumer.js"

const origin = "http://notion.test",
  databaseId = "00000000-0000-4000-8000-000000000001"
const setup = () => {
  const runtime = createRuntime({ clock: createClock(() => Date.UTC(2026, 0, 1)) })
  const fetchImpl = ((input: RequestInfo | URL, init?: RequestInit) =>
    runtime.fetch(new Request(input, init))) as typeof fetch
  return { runtime, fetchImpl, consumer: client(fetchImpl, origin) }
}
test("legacy database search exposes the authorized id and schema", async () => {
  const { consumer } = setup(),
    result = await (await consumer.search()).json()
  expect(result.type).toBe("page_or_database")
  expect(result.results).toHaveLength(1)
  expect(result.results[0]).toMatchObject({
    object: "database",
    id: databaseId,
    properties: { Name: { type: "title" }, Score: { type: "number" } },
  })
  expect(result.next_cursor).toBeNull()
  expect(result.has_more).toBe(false)
})
test("valid page properties persist under the same database with UUID identity", async () => {
  const { runtime, consumer } = setup()
  const response = await consumer.create(databaseId, {
    Name: { title: [{ text: { content: "Synthetic answer" } }] },
    Score: { number: 8 },
  })
  expect(response.status).toBe(200)
  const page = await response.json()
  expect(page.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/)
  expect(page.parent.database_id).toBe(databaseId)
  expect(runtime.instance().pages.get(page.id)).toMatchObject({
    databaseId,
    properties: { Score: { type: "number", number: 8 } },
  })
})
test("invalid properties and inaccessible/read-only parents never create pages", async () => {
  const { runtime, fetchImpl, consumer } = setup()
  expect((await consumer.create(databaseId, { Score: { number: "wrong" } })).status).toBe(400)
  expect((await consumer.create(databaseId, { Unknown: { number: 1 } })).status).toBe(400)
  expect((await consumer.create("missing", {})).status).toBe(404)
  runtime.instance().grants.insert("read_only", {
    token: "read_only",
    workspaceId: "mock-workspace",
    databaseIds: [databaseId],
    write: false,
  })
  expect((await client(fetchImpl, origin, "read_only").create(databaseId, {})).status).toBe(403)
  expect(runtime.instance().pages.count()).toBe(0)
  expect((await client(fetchImpl, origin, "wrong").search()).status).toBe(401)
})
test("unfiltered search includes untitled pages but title queries do not", async () => {
  const { consumer, fetchImpl } = setup()
  await consumer.create(databaseId, {})
  const search = (query: string) =>
    fetchImpl(`${origin}/v1/search`, {
      method: "POST",
      headers: {
        authorization: "Bearer mock_notion_token",
        "notion-version": "2022-06-28",
        "content-type": "application/json",
      },
      body: JSON.stringify({ filter: { property: "object", value: "page" }, query }),
    })
  expect((await (await search("")).json()).results).toHaveLength(1)
  expect((await (await search("missing")).json()).results).toHaveLength(0)
})
test("pagination, namespaces, reset and journals retain isolation", async () => {
  const { runtime, fetchImpl, consumer } = setup(),
    db = DEFAULT_DATABASES[0]
  if (!db) throw new Error("Missing database fixture")
  runtime.instance().databases.insert("second", { ...db, id: "second" })
  runtime.instance().grants.insert("mock_notion_token", {
    token: "mock_notion_token",
    workspaceId: "mock-workspace",
    databaseIds: [databaseId, "second"],
    write: true,
  })
  const first = await (await consumer.search(1)).json(),
    second = await (await consumer.search(1, first.next_cursor)).json()
  expect(first.has_more).toBe(true)
  expect(second.results[0].id).toBe("second")
  expect(second.has_more).toBe(false)
  const other = client(fetchImpl, `${origin}/__admin/ns/other`)
  expect((await (await other.search()).json()).results).toHaveLength(1)
  await other.create(databaseId, {
    Name: { title: [{ text: { content: "private synthetic body" } }] },
  })
  await runtime.reset("other")
  expect(runtime.instance("other").pages.count()).toBe(0)
  expect(runtime.instance().databases.count()).toBe(2)
  const journal = await (await fetchImpl(`${origin}/__admin/requests`)).text()
  expect(journal).not.toContain("mock_notion_token")
  expect(journal).not.toContain("private synthetic body")
})
test("OAuth code exchange is client-bound, single-use and workspace-scoped", async () => {
  const { runtime, fetchImpl } = setup()
  const code: OAuthCode = {
    code: "mock_code",
    clientId: "mock_client",
    redirectUri: "https://app.example.test/callback",
    used: false,
    grant: {
      token: "mock_oauth_token",
      workspaceId: "mock-workspace",
      databaseIds: [databaseId],
      write: true,
    },
  }
  runtime.instance().codes.insert(code.code, code)
  const exchange = (redirectUri = code.redirectUri) =>
    fetchImpl(`${origin}/v1/oauth/token`, {
      method: "POST",
      headers: {
        authorization: `Basic ${btoa("mock_client:mock_client_secret")}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        grant_type: "authorization_code",
        code: code.code,
        redirect_uri: redirectUri,
      }),
    })
  expect((await exchange("https://other.example.test")).status).toBe(400)
  const response = await exchange()
  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({
    access_token: "mock_oauth_token",
    workspace_id: "mock-workspace",
  })
  expect((await exchange()).status).toBe(400)
  expect((await client(fetchImpl, origin, "mock_oauth_token").search()).status).toBe(200)
})
test("served HTTP version errors and scripted quota failures remain vendor-shaped", async () => {
  const server = await createServer()
  try {
    const response = await fetch(`${server.url}/v1/search`, {
      method: "POST",
      headers: { authorization: "Bearer mock_notion_token", "content-type": "application/json" },
      body: "{}",
    })
    expect(await response.json()).toMatchObject({
      object: "error",
      code: "missing_version",
      status: 400,
    })
    server.runtime.applyPreset("rate_limited", "default", { count: 1 })
    const quota = await client(fetch, server.url).search()
    expect(quota.status).toBe(429)
    expect(quota.headers.get("retry-after")).toBe("1")
    expect((await client(fetch, server.url).search()).status).toBe(200)
  } finally {
    await server.close()
  }
})
describe("GET /v1/blocks/{block_id}/children (docs-verified shape; pagination and errors best guess)", () => {
  const pageId = "1429989f-e8ac-4eff-bc8f-57f56486db54"
  const seed = (runtime: ReturnType<typeof createRuntime>, body: unknown, id = pageId) =>
    runtime.fetch(
      new Request(`${origin}/__admin/pages/${id}/blocks`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    )
  const faq = [
    { type: "heading_2", text: "Support FAQ" },
    { type: "paragraph", text: "Reach us any time." },
    { type: "paragraph", text: "Replies take a day." },
  ]

  test("a seeded page lists its children in order as Notion block objects", async () => {
    const { runtime, consumer } = setup()
    expect((await seed(runtime, { blocks: faq })).status).toBe(200)
    const response = await consumer.blockChildren(pageId)
    expect(response.status).toBe(200)
    const list = await response.json()
    expect(list).toMatchObject({
      object: "list",
      next_cursor: null,
      has_more: false,
      type: "block",
      block: {},
    })
    expect(list.results.map((block: { type: string }) => block.type)).toEqual([
      "heading_2",
      "paragraph",
      "paragraph",
    ])
    expect(list.results[1]).toMatchObject({
      object: "block",
      type: "paragraph",
      has_children: false,
      parent: { type: "page_id", page_id: pageId },
      archived: false,
      paragraph: {
        rich_text: [
          {
            type: "text",
            text: { content: "Reach us any time.", link: null },
            plain_text: "Reach us any time.",
          },
        ],
      },
    })
    expect(list.results[1].id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/,
    )
    // The same page without hyphens resolves too.
    expect((await consumer.blockChildren(pageId.replaceAll("-", ""))).status).toBe(200)
  })

  test("more children than page_size are paged with start_cursor and next_cursor", async () => {
    const { runtime, fetchImpl } = setup()
    await seed(runtime, {
      blocks: Array.from({ length: 5 }, (_, index) => ({
        type: "paragraph",
        text: `line ${index}`,
      })),
    })
    const get = async (query: string) =>
      (await (
        await fetchImpl(`${origin}/v1/blocks/${pageId}/children?${query}`, {
          headers: { authorization: "Bearer mock_notion_token", "notion-version": "2022-06-28" },
        })
      ).json()) as {
        results: { id: string; paragraph: { rich_text: { plain_text: string }[] } }[]
        has_more: boolean
        next_cursor: string | null
      }
    const text = (page: Awaited<ReturnType<typeof get>>) =>
      page.results.map((block) => block.paragraph.rich_text[0]?.plain_text)
    const first = await get("page_size=2")
    expect(first.has_more).toBe(true)
    expect(typeof first.next_cursor).toBe("string")
    expect(text(first)).toEqual(["line 0", "line 1"])
    const second = await get(`page_size=2&start_cursor=${first.next_cursor}`)
    expect(text(second)).toEqual(["line 2", "line 3"])
    expect(second.has_more).toBe(true)
    const last = await get(`page_size=2&start_cursor=${second.next_cursor}`)
    expect(text(last)).toEqual(["line 4"])
    expect([last.has_more, last.next_cursor]).toEqual([false, null])
    const response = await fetchImpl(`${origin}/v1/blocks/${pageId}/children?start_cursor=nope`, {
      headers: { authorization: "Bearer mock_notion_token", "notion-version": "2022-06-28" },
    })
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ object: "error", code: "validation_error" })
  })

  test("a block that reports has_children lists its nested blocks, and the loader flattens the tree", async () => {
    const { runtime, fetchImpl, consumer } = setup()
    await seed(runtime, {
      blocks: [
        { type: "heading_1", text: "FAQ" },
        {
          type: "toggle",
          text: "How do refunds work?",
          children: [
            { type: "paragraph", text: "Within 30 days." },
            {
              type: "bulleted_list_item",
              text: "Ask support",
              children: [{ type: "to_do", text: "Attach receipt", checked: true }],
            },
            { type: "code", text: "refund --all", language: "bash", caption: "Run it" },
          ],
        },
        { type: "numbered_list_item", text: "One" },
        { type: "quote", text: "Quoted" },
        { type: "callout", text: "Heads up" },
        { type: "heading_3", text: "Small" },
      ],
    })
    const top = await (await consumer.blockChildren(pageId)).json()
    const toggle = top.results[1]
    expect(toggle).toMatchObject({ type: "toggle", has_children: true })
    const nested = await (await consumer.blockChildren(toggle.id)).json()
    expect(nested.results.map((block: { type: string }) => block.type)).toEqual([
      "paragraph",
      "bulleted_list_item",
      "code",
    ])
    expect(nested.results[0].parent).toEqual({ type: "block_id", block_id: toggle.id })
    expect(nested.results[2].code).toMatchObject({
      language: "bash",
      caption: [{ plain_text: "Run it" }],
      rich_text: [{ plain_text: "refund --all" }],
    })
    const deeper = await (await consumer.blockChildren(nested.results[1].id)).json()
    expect(deeper.results[0]).toMatchObject({ type: "to_do", to_do: { checked: true } })
    expect(await pageMarkdown(fetchImpl, origin, pageId)).toBe(
      [
        "# FAQ",
        "How do refunds work?",
        "  Within 30 days.",
        "  - Ask support",
        "    - [x] Attach receipt",
        "  ```bash",
        "  refund --all",
        "  ```",
        "  Run it",
        "1. One",
        "> Quoted",
        "> Heads up",
        "### Small",
      ].join("\n"),
    )
  })

  test("a page with no seeded blocks lists none; an unknown id or an unshared page is 404; a non-UUID is 400", async () => {
    const { runtime, fetchImpl, consumer } = setup()
    const created = await (
      await consumer.create(databaseId, { Name: { title: [{ text: { content: "Empty" } }] } })
    ).json()
    expect(await (await consumer.blockChildren(created.id)).json()).toMatchObject({
      results: [],
      has_more: false,
    })
    const unknown = await consumer.blockChildren("00000000-0000-4000-8000-00000000dead")
    expect(unknown.status).toBe(404)
    expect(await unknown.json()).toMatchObject({
      object: "error",
      status: 404,
      code: "object_not_found",
    })
    const invalid = await consumer.blockChildren("not-a-uuid")
    expect(invalid.status).toBe(400)
    expect(await invalid.json()).toMatchObject({
      object: "error",
      status: 400,
      code: "validation_error",
    })
    // A page in another workspace, and one in a database the grant does not cover.
    await seed(runtime, { blocks: faq, workspaceId: "someone-else" })
    expect((await consumer.blockChildren(pageId)).status).toBe(404)
    runtime.instance().grants.insert("narrow", {
      token: "narrow",
      workspaceId: "mock-workspace",
      databaseIds: [],
      write: false,
    })
    expect((await client(fetchImpl, origin, "narrow").blockChildren(created.id)).status).toBe(404)
  })

  test("a missing or unknown token is 401 and a rate_limited fault is 429 with Retry-After", async () => {
    const { runtime, fetchImpl, consumer } = setup()
    await seed(runtime, { blocks: faq })
    expect((await client(fetchImpl, origin, "wrong").blockChildren(pageId)).status).toBe(401)
    const anonymous = await fetchImpl(`${origin}/v1/blocks/${pageId}/children`, {
      headers: { "notion-version": "2022-06-28" },
    })
    expect(anonymous.status).toBe(401)
    expect(await anonymous.json()).toMatchObject({ code: "unauthorized" })
    runtime.applyPreset("rate_limited", "default", { count: 1 })
    const limited = await consumer.blockChildren(pageId)
    expect(limited.status).toBe(429)
    expect(limited.headers.get("retry-after")).toBe("1")
    expect(await limited.json()).toMatchObject({ code: "rate_limited" })
    expect((await consumer.blockChildren(pageId)).status).toBe(200)
  })

  test("a bad page_size is 400 validation_error", async () => {
    const { runtime, fetchImpl } = setup()
    await seed(runtime, { blocks: faq })
    for (const size of ["0", "101", "x", "1.5"]) {
      const response = await fetchImpl(`${origin}/v1/blocks/${pageId}/children?page_size=${size}`, {
        headers: { authorization: "Bearer mock_notion_token", "notion-version": "2022-06-28" },
      })
      expect([size, response.status]).toEqual([size, 400])
    }
  })

  test("seeding an invalid outline is a 400 that changes nothing; re-seeding replaces the tree", async () => {
    const { runtime, consumer } = setup()
    await seed(runtime, { blocks: faq })
    const before = runtime.instance().blocks.count()
    for (const blocks of [
      [{ type: "bogus" }],
      [{ type: "paragraph", text: 1 }],
      [{ type: "paragraph", checked: true }],
      [{ type: "paragraph", children: "x" }],
      [{ type: "divider", children: [{ type: "paragraph" }] }],
      "nope",
    ]) {
      const response = await seed(runtime, { blocks })
      expect([JSON.stringify(blocks), response.status]).toEqual([JSON.stringify(blocks), 400])
    }
    expect((await seed(runtime, { blocks: faq }, "nope")).status).toBe(400)
    expect(runtime.instance().blocks.count()).toBe(before)
    await seed(runtime, { blocks: [{ type: "divider" }] })
    const list = await (await consumer.blockChildren(pageId)).json()
    expect(list.results).toHaveLength(1)
    expect(list.results[0]).toMatchObject({ type: "divider", divider: {} })
    expect(runtime.instance().blocks.count()).toBe(1)
  })

  test("blocks are isolated by namespace and cleared by reset", async () => {
    const { runtime, fetchImpl } = setup()
    await seed(runtime, { blocks: faq })
    const other = client(fetchImpl, `${origin}/__admin/ns/other`)
    expect((await other.blockChildren(pageId)).status).toBe(404)
    await runtime.reset()
    expect(runtime.instance().blocks.count()).toBe(0)
    expect(runtime.instance().pages.count()).toBe(0)
  })
})
