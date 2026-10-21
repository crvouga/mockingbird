import type { FetchAPI } from "@crvouga/mockingbird-core"
import {
  type APIOptions,
  annotateResponse,
  basicAuth,
  bearerToken,
  bodyIssues,
  bootSqlite,
  Collection,
  createService,
  defineOperations,
  IdSequence,
  jsonRes,
  type OperationContext,
  type Service,
} from "@crvouga/mockingbird-service"
import type { Hono } from "hono"
import { document, type SupportedOperationId } from "./generated/openapi.js"

export type { OperationId, SupportedOperationId } from "./generated/openapi.js"
export { document, operationIds, supportedOperationIds } from "./generated/openapi.js"
export { createRuntime, NOTION_PRESETS } from "./runtime.js"
export const NOTION_NAMESPACE = "notion"
export type Property = { id: string; name: string; type: string; [key: string]: unknown }
export type Database = {
  id: string
  workspaceId: string
  title: string
  properties: Record<string, Property>
}
export type Grant = { token: string; workspaceId: string; databaseIds: string[]; write: boolean }
export type OAuthCode = {
  code: string
  clientId: string
  redirectUri: string
  grant: Grant
  used: boolean
}
export type Client = { id: string; secret: string }
export type Page = {
  id: string
  workspaceId: string
  /** `null` for a standalone page seeded with `PUT /__admin/pages/{id}/blocks`. */
  databaseId: string | null
  properties: Record<string, unknown>
  createdAt: string
}
/** A stored block: one row of a page's block tree, listed by `GET /v1/blocks/{id}/children`. */
export type Block = {
  id: string
  /** The page or block that lists this block as a child. */
  parentId: string
  parentType: "page_id" | "block_id"
  /** The page the tree hangs from, which decides who may read it. */
  pageId: string
  type: string
  /** The value of the `<type>` key: `rich_text`, `checked`, `language`, `caption`, … */
  content: Record<string, unknown>
  hasChildren: boolean
  createdAt: string
}
/** A seeded block: `text` becomes `rich_text`, `children` nest to any depth. */
export type BlockOutline = {
  type: string
  text?: string
  checked?: boolean
  language?: string
  caption?: string
  children?: BlockOutline[]
}
export const BLOCK_TYPES = [
  "paragraph",
  "heading_1",
  "heading_2",
  "heading_3",
  "bulleted_list_item",
  "numbered_list_item",
  "to_do",
  "toggle",
  "quote",
  "callout",
  "code",
  "divider",
] as const
export type NotionAPIOptions = APIOptions & {
  databases?: Database[]
  grants?: Grant[]
  clients?: Client[]
  codes?: OAuthCode[]
}
export const DEFAULT_DATABASES: Database[] = [
  {
    id: "00000000-0000-4000-8000-000000000001",
    workspaceId: "mock-workspace",
    title: "Synthetic survey",
    properties: {
      Name: { id: "title", name: "Name", type: "title", title: {} },
      Score: { id: "score", name: "Score", type: "number", number: { format: "number" } },
    },
  },
]
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value)
const error = (status: number, code: string, message: string) =>
  jsonRes(status, { object: "error", status, code, message })
const richText = (text: string) => [
  {
    type: "text",
    text: { content: text, link: null },
    plain_text: text,
    href: null,
    annotations: {
      bold: false,
      italic: false,
      strikethrough: false,
      underline: false,
      code: false,
      color: "default",
    },
  },
]
const richTextOf = (text: string | undefined) => (text ? richText(text) : [])
/** A Notion id in either accepted form (hyphenated or 32 hex digits), as the hyphenated lower-case form. */
const normalizeId = (value: string): string | undefined => {
  const hex = value.replaceAll("-", "").toLowerCase()
  if (!/^[0-9a-f]{32}$/.test(hex)) return undefined
  if (
    value.includes("-") &&
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
  )
    return undefined
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
const BOT_USER = { object: "user", id: "00000000-0000-4000-8000-000000000002" }
/** `{text, checked, language, caption}` as the block's `<type>` object, or the problem with it. */
const blockContent = (outline: BlockOutline): Record<string, unknown> | string => {
  const allowed = new Set(["type", "text", "children"])
  if (outline.type === "to_do") allowed.add("checked")
  if (outline.type === "code") for (const key of ["language", "caption"]) allowed.add(key)
  if (outline.type === "divider") allowed.delete("text")
  for (const key of Object.keys(outline))
    if (!allowed.has(key)) return `${key} is not supported on a ${outline.type} block`
  if (outline.text !== undefined && typeof outline.text !== "string") return "text must be a string"
  if (outline.type === "divider") return {}
  const content: Record<string, unknown> = { rich_text: richTextOf(outline.text) }
  if (outline.type === "to_do") {
    if (outline.checked !== undefined && typeof outline.checked !== "boolean")
      return "checked must be a boolean"
    content.checked = outline.checked ?? false
  }
  if (outline.type === "code") {
    if (outline.language !== undefined && typeof outline.language !== "string")
      return "language must be a string"
    if (outline.caption !== undefined && typeof outline.caption !== "string")
      return "caption must be a string"
    content.language = outline.language ?? "plain text"
    content.caption = richTextOf(outline.caption)
  } else {
    content.color = "default"
    if (outline.type === "callout") content.icon = { type: "emoji", emoji: "\u{1F4A1}" }
  }
  return content
}
type CheckedBlock = { type: string; content: Record<string, unknown>; children: CheckedBlock[] }
/** A seeded outline checked end to end, or the first problem with it. */
const checkOutline = (items: unknown): CheckedBlock[] | string => {
  if (!Array.isArray(items)) return "blocks must be an array of {type, text?, children?}"
  const checked: CheckedBlock[] = []
  for (const item of items) {
    if (!record(item) || typeof item.type !== "string")
      return "each block must be an object with a type"
    const outline = item as BlockOutline
    if (!(BLOCK_TYPES as readonly string[]).includes(outline.type))
      return `unsupported block type ${outline.type}; use one of ${BLOCK_TYPES.join(", ")}`
    const content = blockContent(outline)
    if (typeof content === "string") return content
    if (outline.children !== undefined && !Array.isArray(outline.children))
      return "children must be an array"
    if (outline.children?.length && outline.type === "divider") return "a divider has no children"
    const children = checkOutline(outline.children ?? [])
    if (typeof children === "string") return children
    checked.push({ type: outline.type, content, children })
  }
  return checked
}
const validProperty = (type: string, value: unknown): boolean => {
  if (["title", "rich_text"].includes(type))
    return (
      Array.isArray(value) &&
      value.every(
        (item) =>
          record(item) &&
          record(item.text) &&
          typeof item.text.content === "string" &&
          item.text.content.length <= 2000,
      )
    )
  if (type === "number")
    return value === null || (typeof value === "number" && Number.isFinite(value))
  if (type === "checkbox") return typeof value === "boolean"
  if (["url", "email", "phone_number"].includes(type))
    return value === null || typeof value === "string"
  if (type === "date")
    return (
      value === null ||
      (record(value) &&
        typeof value.start === "string" &&
        Number.isFinite(Date.parse(value.start)) &&
        (value.end === undefined ||
          value.end === null ||
          (typeof value.end === "string" && Number.isFinite(Date.parse(value.end)))))
    )
  if (["select", "status"].includes(type))
    return (
      value === null ||
      (record(value) && (typeof value.id === "string" || typeof value.name === "string"))
    )
  if (type === "multi_select")
    return (
      Array.isArray(value) && value.every((item) => validProperty("select", item) && item !== null)
    )
  if (["people", "relation"].includes(type))
    return (
      Array.isArray(value) && value.every((item) => record(item) && typeof item.id === "string")
    )
  if (type === "files")
    return (
      Array.isArray(value) &&
      value.every(
        (item) =>
          record(item) &&
          typeof item.name === "string" &&
          ((record(item.external) && typeof item.external.url === "string") ||
            (record(item.file) && typeof item.file.url === "string")),
      )
    )
  return false
}
export class NotionAPI implements FetchAPI {
  readonly app: Hono
  readonly databases: Collection<Database>
  readonly grants: Collection<Grant>
  readonly codes: Collection<OAuthCode>
  readonly clients: Collection<Client>
  readonly pages: Collection<Page>
  readonly blocks: Collection<Block>
  private readonly initialized: Collection<{ value: boolean }>
  private readonly ids: IdSequence
  private readonly service: Service
  private readonly now: () => number
  private readonly fixtures: {
    databases: Database[]
    grants: Grant[]
    clients: Client[]
    codes: OAuthCode[]
  }
  constructor(options: NotionAPIOptions = {}) {
    const sqlite = bootSqlite(options.sqlite),
      namespace = options.namespace ?? NOTION_NAMESPACE
    this.now = options.now ?? Date.now
    this.databases = new Collection(sqlite, namespace, "databases")
    this.grants = new Collection(sqlite, namespace, "grants")
    this.codes = new Collection(sqlite, namespace, "codes")
    this.clients = new Collection(sqlite, namespace, "clients")
    this.pages = new Collection(sqlite, namespace, "pages")
    this.blocks = new Collection(sqlite, namespace, "blocks")
    this.initialized = new Collection(sqlite, namespace, "initialized")
    this.ids = new IdSequence(sqlite, namespace)
    this.fixtures = structuredClone({
      databases: options.databases ?? DEFAULT_DATABASES,
      grants: options.grants ?? [
        {
          token: "mock_notion_token",
          workspaceId: "mock-workspace",
          databaseIds: DEFAULT_DATABASES.map((db) => db.id),
          write: true,
        },
      ],
      clients: options.clients ?? [{ id: "mock_client", secret: "mock_client_secret" }],
      codes: options.codes ?? [],
    })
    this.seed()
    this.service = createService({
      document,
      sqlite,
      namespace,
      now: this.now,
      notFound: () => error(404, "object_not_found", "Could not find resource"),
      onError: (thrown) => {
        throw thrown
      },
      before: (context) => {
        if (context.operation.operationId === "OAuthToken") return undefined
        if (!this.grant(context)) return error(401, "unauthorized", "API token is invalid.")
        const version = context.request.headers.get("notion-version")
        if (!version) return error(400, "missing_version", "Notion-Version header is required.")
        if (version !== "2022-06-28")
          return error(400, "validation_error", "This mock supports Notion-Version 2022-06-28.")
        return undefined
      },
      handlers: defineOperations<SupportedOperationId>({
        OAuthToken: (context) => this.exchange(context),
        Search: (context) => this.search(context),
        CreatePage: (context) => this.create(context),
        GetBlockChildren: (context) => this.children(context),
      }),
    })
    this.app = this.service.app
  }
  private seed(): void {
    if (this.initialized.has("seed")) return
    for (const db of this.fixtures.databases) this.databases.insert(db.id, db)
    for (const grant of this.fixtures.grants) this.grants.insert(grant.token, grant)
    for (const code of this.fixtures.codes) this.codes.insert(code.code, code)
    for (const client of this.fixtures.clients) this.clients.insert(client.id, client)
    this.initialized.insert("seed", { value: true })
  }
  fetch(request: Request): Promise<Response> {
    return this.service.fetch(request)
  }
  async reset(): Promise<void> {
    await this.service.reset()
    this.seed()
  }
  private body(context: OperationContext): Record<string, unknown> | undefined {
    return !bodyIssues(context).length && context.body.kind === "json" && record(context.body.value)
      ? context.body.value
      : undefined
  }
  private grant(context: OperationContext): Grant | undefined {
    return this.grants.get(bearerToken(context.request) ?? "")
  }
  private exchange(context: OperationContext): Response {
    const auth = basicAuth(context.request),
      client = auth ? this.clients.get(auth.username) : undefined
    if (!client || client.secret !== auth?.password)
      return jsonRes(401, { error: "invalid_client" })
    const body = this.body(context)
    if (body?.grant_type !== "authorization_code") return jsonRes(400, { error: "invalid_request" })
    const code = this.codes.get(String(body.code))
    if (
      !code ||
      code.used ||
      code.clientId !== client.id ||
      (body.redirect_uri !== undefined && body.redirect_uri !== code.redirectUri)
    )
      return jsonRes(400, { error: "invalid_grant" })
    this.codes.insert(code.code, { ...code, used: true })
    this.grants.insert(code.grant.token, code.grant)
    return jsonRes(200, {
      access_token: code.grant.token,
      token_type: "bearer",
      bot_id: "00000000-0000-4000-8000-000000000002",
      workspace_id: code.grant.workspaceId,
      workspace_name: "Synthetic workspace",
      workspace_icon: null,
      owner: { type: "workspace", workspace: true },
      duplicated_template_id: null,
    })
  }
  private databaseView(db: Database): Record<string, unknown> {
    return {
      object: "database",
      id: db.id,
      title: richText(db.title),
      properties: db.properties,
      parent: { type: "workspace", workspace: true },
      archived: false,
      is_inline: false,
      description: [],
      icon: null,
      cover: null,
      url: `https://www.notion.so/${db.id.replaceAll("-", "")}`,
    }
  }
  private pageView(page: Page): Record<string, unknown> {
    return {
      object: "page",
      id: page.id,
      parent:
        page.databaseId === null
          ? { type: "workspace", workspace: true }
          : { type: "database_id", database_id: page.databaseId },
      properties: page.properties,
      created_time: page.createdAt,
      last_edited_time: page.createdAt,
      archived: false,
      icon: null,
      cover: null,
      url: `https://www.notion.so/${page.id.replaceAll("-", "")}`,
    }
  }
  private search(context: OperationContext): Response {
    const body = this.body(context),
      grant = this.grant(context)
    if (!body || !grant) return error(400, "validation_error", "Invalid search body.")
    const filter = record(body.filter) ? body.filter.value : undefined
    const query = typeof body.query === "string" ? body.query.toLowerCase() : ""
    const databases = this.databases
      .list({ order: "oldest" })
      .map(({ value }) => value)
      .filter(
        (db) =>
          grant.workspaceId === db.workspaceId &&
          grant.databaseIds.includes(db.id) &&
          db.title.toLowerCase().includes(query),
      )
      .map((db) => this.databaseView(db))
    const pages = this.pages
      .list({ order: "oldest" })
      .map(({ value }) => value)
      .filter(
        (page) =>
          page.workspaceId === grant.workspaceId &&
          (page.databaseId === null || grant.databaseIds.includes(page.databaseId)) &&
          (!query ||
            Object.values(page.properties).some(
              (property) =>
                record(property) &&
                property.type === "title" &&
                Array.isArray(property.title) &&
                property.title
                  .map((item) =>
                    record(item) && record(item.text) ? String(item.text.content ?? "") : "",
                  )
                  .join("")
                  .toLowerCase()
                  .includes(query),
            )),
      )
      .map((page) => this.pageView(page))
    const values =
      filter === "database" ? databases : filter === "page" ? pages : [...databases, ...pages]
    const size = typeof body.page_size === "number" ? body.page_size : 100
    const prior = body.start_cursor
      ? values.findIndex((value) => value.id === body.start_cursor)
      : -1
    if (body.start_cursor && prior < 0)
      return error(400, "validation_error", "Invalid start_cursor.")
    const results = values.slice(prior + 1, prior + 1 + size),
      more = prior + 1 + size < values.length
    return jsonRes(200, {
      object: "list",
      type: "page_or_database",
      page_or_database: {},
      results,
      has_more: more,
      next_cursor: more ? results.at(-1)?.id : null,
    })
  }
  private newId(): string {
    const raw = Array.from(this.ids.next("", 32), (char) =>
      (char.charCodeAt(0) % 16).toString(16),
    ).join("")
    return `${raw.slice(0, 8)}-${raw.slice(8, 12)}-4${raw.slice(13, 16)}-8${raw.slice(17, 20)}-${raw.slice(20)}`
  }
  /** Whether the grant may read the page: its workspace, and its database when it has one. */
  private readable(grant: Grant, page: Page | undefined): page is Page {
    return (
      page !== undefined &&
      page.workspaceId === grant.workspaceId &&
      (page.databaseId === null || grant.databaseIds.includes(page.databaseId))
    )
  }
  private blockView(block: Block): Record<string, unknown> {
    return {
      object: "block",
      id: block.id,
      parent:
        block.parentType === "page_id"
          ? { type: "page_id", page_id: block.parentId }
          : { type: "block_id", block_id: block.parentId },
      created_time: block.createdAt,
      last_edited_time: block.createdAt,
      created_by: BOT_USER,
      last_edited_by: BOT_USER,
      has_children: block.hasChildren,
      archived: false,
      type: block.type,
      [block.type]: block.content,
    }
  }
  private children(context: OperationContext): Response {
    const grant = this.grant(context)
    const raw = context.params.block_id ?? ""
    const id = normalizeId(raw)
    if (!grant) return error(401, "unauthorized", "API token is invalid.")
    if (!id)
      return error(
        400,
        "validation_error",
        `path failed validation: path.block_id should be a valid uuid, instead was \`"${raw}"\`.`,
      )
    const pageSize = context.url.searchParams.get("page_size")
    const size = pageSize === null ? 100 : Number(pageSize)
    if (pageSize !== null && (!/^\d+$/.test(pageSize) || size < 1 || size > 100))
      return error(
        400,
        "validation_error",
        "query failed validation: query.page_size should be a number between 1 and 100.",
      )
    const block = this.blocks.get(id)
    if (!this.readable(grant, this.pages.get(block?.pageId ?? id)))
      return error(
        404,
        "object_not_found",
        `Could not find block with ID: ${id}. Make sure the relevant pages and databases are shared with your integration.`,
      )
    const siblings = this.blocks
      .list({ order: "oldest", where: (child) => child.parentId === id })
      .map(({ value }) => value)
    const cursor = context.url.searchParams.get("start_cursor")
    const prior = cursor ? siblings.findIndex((child) => child.id === cursor) : -1
    if (cursor && prior < 0)
      return error(400, "validation_error", `start_cursor provided is invalid: ${cursor}`)
    const results = siblings.slice(prior + 1, prior + 1 + size),
      more = prior + 1 + size < siblings.length
    return annotateResponse(
      jsonRes(200, {
        object: "list",
        results: results.map((child) => this.blockView(child)),
        next_cursor: more ? (results.at(-1)?.id ?? null) : null,
        has_more: more,
        type: "block",
        block: {},
      }),
      { ids: { blockId: id } },
    )
  }
  /**
   * Replace a page's block tree with the nested `outline` (creating a standalone page in
   * `workspaceId` when `pageId` is not a page yet). Everything is validated before anything is
   * written; a problem comes back as a message and changes nothing.
   */
  seedBlocks(
    pageId: string,
    outline: unknown,
    options: { workspaceId?: string; title?: string } = {},
  ): { id: string; blocks: number } | string {
    const id = normalizeId(pageId)
    if (!id) return "the page id must be a UUID"
    const existing = this.pages.get(id)
    if (!existing && this.blocks.has(id)) return `${id} is a block, not a page`
    const tree = checkOutline(outline)
    if (typeof tree === "string") return tree
    const createdAt = new Date(this.now()).toISOString()
    const rows: Block[] = []
    const flatten = (nodes: CheckedBlock[], parentId: string, parentType: Block["parentType"]) => {
      for (const node of nodes) {
        const blockId = this.newId()
        rows.push({
          id: blockId,
          parentId,
          parentType,
          pageId: id,
          type: node.type,
          content: node.content,
          hasChildren: node.children.length > 0,
          createdAt,
        })
        flatten(node.children, blockId, "block_id")
      }
    }
    flatten(tree, id, "page_id")
    for (const { id: oldId } of this.blocks.list({ where: (block) => block.pageId === id }))
      this.blocks.delete(oldId)
    if (!existing) {
      const properties = options.title
        ? { title: { id: "title", type: "title", title: richText(options.title) } }
        : {}
      this.pages.insert(id, {
        id,
        databaseId: null,
        workspaceId:
          options.workspaceId ?? this.fixtures.grants[0]?.workspaceId ?? "mock-workspace",
        properties,
        createdAt,
      })
    }
    for (const row of rows) this.blocks.insert(row.id, row)
    return { id, blocks: rows.length }
  }
  private create(context: OperationContext): Response {
    const body = this.body(context),
      grant = this.grant(context)
    if (!body || !grant || !record(body.parent) || !record(body.properties))
      return error(400, "validation_error", "Invalid page body.")
    const db = this.databases.get(String(body.parent.database_id))
    if (!db || db.workspaceId !== grant.workspaceId || !grant.databaseIds.includes(db.id))
      return error(404, "object_not_found", "Could not find database.")
    if (!grant.write)
      return error(403, "restricted_resource", "Insufficient permissions for this operation.")
    const properties: Record<string, unknown> = {}
    for (const [name, input] of Object.entries(body.properties)) {
      const config =
        db.properties[name] ?? Object.values(db.properties).find((property) => property.id === name)
      if (!config) return error(400, "validation_error", `${name} is not a property that exists.`)
      const value = record(input) && Object.hasOwn(input, config.type) ? input[config.type] : input
      if (!validProperty(config.type, value))
        return error(400, "validation_error", `Invalid ${config.type} value for ${name}.`)
      properties[config.name] = { id: config.id, type: config.type, [config.type]: value }
    }
    const id = this.newId()
    const page: Page = {
      id,
      databaseId: db.id,
      workspaceId: db.workspaceId,
      properties,
      createdAt: new Date(this.now()).toISOString(),
    }
    this.pages.insert(id, page)
    const response = jsonRes(200, this.pageView(page))
    annotateResponse(response, { ids: { pageId: id } })
    return response
  }
}
