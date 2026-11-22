import { Card, Chip } from "@heroui/react"
import { Code, Copyable, Head, Properties, Section } from "../kit.js"
import { ApiError, ui } from "../runtime.js"

/** The colour of an HTTP method: reads green, writes amber, deletes red. */
const METHOD_COLOR = {
  GET: "success",
  POST: "accent",
  PUT: "warning",
  PATCH: "warning",
  DELETE: "danger",
} as const

type Operation = { method: string; path: string; summary: string }

export async function reference() {
  const response = await fetch("/api/openapi.json")
  if (!response.ok) throw new ApiError(response.status, `HTTP ${response.status}`)
  const spec = (await response.json()) as {
    servers: { url: string }[]
    paths: Record<string, Record<string, { summary: string; tags: string[] }>>
  }
  const groups = new Map<string, Operation[]>()
  for (const [path, item] of Object.entries(spec.paths))
    for (const [method, operation] of Object.entries(item)) {
      const tag = operation.tags[0] ?? "Other"
      groups.set(tag, [
        ...(groups.get(tag) ?? []),
        { method: method.toUpperCase(), path, summary: operation.summary },
      ])
    }
  return (
    <>
      <Head
        title="API reference"
        sub={
          <>
            Everything this dashboard does is one of these calls. Send{" "}
            <Code>Authorization: Bearer &lt;token or key&gt;</Code>.
          </>
        }
      />
      <Properties
        label="Where the API lives"
        rows={[
          { name: "Base URL", value: <Copyable value={spec.servers[0]?.url ?? ""} /> },
          {
            name: "OpenAPI document",
            value: <Copyable value={`${ui.address.origin()}/api/openapi.json`} />,
          },
        ]}
      />
      {[...groups].map(([tag, operations]) => (
        <Section key={tag} title={tag}>
          <Card className="gap-0 overflow-hidden p-0">
            <ul className="m-0 flex list-none flex-col divide-y divide-separator p-0">
              {operations.map((operation) => (
                <li
                  key={`${operation.method} ${operation.path}`}
                  className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 text-sm"
                >
                  <Chip
                    size="sm"
                    variant="soft"
                    color={METHOD_COLOR[operation.method as keyof typeof METHOD_COLOR] ?? "default"}
                    className="w-16 justify-center font-mono"
                  >
                    <Chip.Label>{operation.method}</Chip.Label>
                  </Chip>
                  <code className="min-w-0 font-mono text-[13px] break-all">{operation.path}</code>
                  <span className="text-muted">{operation.summary}</span>
                </li>
              ))}
            </ul>
          </Card>
        </Section>
      ))}
    </>
  )
}
