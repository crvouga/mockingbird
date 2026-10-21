export const client = (fetchImpl: typeof fetch, base: string, token = "mock_notion_token") => {
  const post = (path: string, body: unknown) =>
    fetchImpl(`${base}${path}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "notion-version": "2022-06-28",
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    })
  const get = (path: string) =>
    fetchImpl(`${base}${path}`, {
      headers: { authorization: `Bearer ${token}`, "notion-version": "2022-06-28" },
    })
  return {
    blockChildren: (blockId: string, cursor?: string) =>
      get(`/v1/blocks/${blockId}/children${cursor ? `?start_cursor=${cursor}` : ""}`),
    search: (size = 100, cursor?: string) =>
      post("/v1/search", {
        filter: { property: "object", value: "database" },
        page_size: size,
        ...(cursor ? { start_cursor: cursor } : {}),
      }),
    create: (databaseId: string, properties: Record<string, unknown>) =>
      post("/v1/pages", { parent: { database_id: databaseId }, properties }),
  }
}

type ListedBlock = {
  id: string
  type: string
  has_children: boolean
  [type: string]: unknown
}
type BlockPage = { results: ListedBlock[]; has_more: boolean; next_cursor: string | null }
const plain = (items: unknown): string =>
  Array.isArray(items) ? items.map((item) => String(item?.plain_text ?? "")).join("") : ""

/**
 * The consumer's support-FAQ loader: every page of a block's children (following `next_cursor`),
 * then each child that reports `has_children` once more, to any depth, flattened to markdown.
 */
export const pageMarkdown = async (
  fetchImpl: typeof fetch,
  base: string,
  blockId: string,
  token = "mock_notion_token",
  depth = 0,
): Promise<string> => {
  const api = client(fetchImpl, base, token)
  const lines: string[] = []
  let cursor: string | undefined
  do {
    const response = await api.blockChildren(blockId, cursor)
    if (!response.ok) throw new Error(`Notion ${response.status}`)
    const page = (await response.json()) as BlockPage
    for (const block of page.results) {
      const body = (block[block.type] ?? {}) as Record<string, unknown>
      const text = plain(body.rich_text)
      const indent = "  ".repeat(depth)
      if (block.type === "heading_1") lines.push(`${indent}# ${text}`)
      else if (block.type === "heading_2") lines.push(`${indent}## ${text}`)
      else if (block.type === "heading_3") lines.push(`${indent}### ${text}`)
      else if (block.type === "bulleted_list_item") lines.push(`${indent}- ${text}`)
      else if (block.type === "numbered_list_item") lines.push(`${indent}1. ${text}`)
      else if (block.type === "to_do")
        lines.push(`${indent}- [${body.checked ? "x" : " "}] ${text}`)
      else if (block.type === "quote") lines.push(`${indent}> ${text}`)
      else if (block.type === "callout") lines.push(`${indent}> ${text}`)
      else if (block.type === "code") {
        const caption = plain(body.caption)
        lines.push(`${indent}\`\`\`${body.language ?? ""}`, `${indent}${text}`, `${indent}\`\`\``)
        if (caption) lines.push(`${indent}${caption}`)
      } else lines.push(`${indent}${text}`)
      if (block.has_children)
        lines.push(await pageMarkdown(fetchImpl, base, block.id, token, depth + 1))
    }
    cursor = page.has_more && page.next_cursor ? page.next_cursor : undefined
  } while (cursor)
  return lines.join("\n")
}
