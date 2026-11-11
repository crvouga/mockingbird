import { h } from "../dom.js"
import { ApiError, copyable, head, properties, ui } from "../runtime.js"

export async function reference() {
  const response = await fetch("/api/openapi.json")
  if (!response.ok) throw new ApiError(response.status, `HTTP ${response.status}`)
  const spec = (await response.json()) as {
    servers: { url: string }[]
    paths: Record<string, Record<string, { summary: string; tags: string[] }>>
  }
  const groups = new Map<string, HTMLElement[]>()
  for (const [path, item] of Object.entries(spec.paths))
    for (const [method, operation] of Object.entries(item)) {
      const tag = operation.tags[0] ?? "Other"
      groups.set(tag, [
        ...(groups.get(tag) ?? []),
        h(
          ".op",
          {},
          h(`span.method.${method.toUpperCase()}`, {}, method.toUpperCase()),
          h("code", {}, path),
          h("span.summary", {}, operation.summary),
        ),
      ])
    }
  return [
    head("API reference", [
      "Everything this dashboard does is one of these calls. Send ",
      h("code", {}, "Authorization: Bearer <token or key>"),
      ".",
    ]),
    properties("Where the API lives", [
      { name: "Base URL", value: copyable(spec.servers[0]?.url ?? "", "Copy") },
      {
        name: "OpenAPI document",
        value: copyable(`${ui.address.origin()}/api/openapi.json`, "Copy"),
      },
    ]),
    [...groups].map(([tag, operations]) =>
      h("section", {}, h("h2", {}, tag), h(".list", {}, operations)),
    ),
  ]
}
