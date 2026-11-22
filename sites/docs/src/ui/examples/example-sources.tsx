import { Card } from "@heroui/react"
import { Icon } from "../icon.tsx"
import { Prose } from "../prose.tsx"

const SUMMARY =
  "flex cursor-pointer list-none items-center gap-2 text-sm font-medium text-foreground [&::-webkit-details-marker]:hidden"
const CHEVRON = "size-3.5 shrink-0 text-muted transition-transform"

/**
 * An example's source files, collapsed under one card. Native `<details>`, so they open without
 * JavaScript (the page renders them on the server and hydrates nothing here).
 */
export function ExampleSources({ sources }: { sources: { path: string; html: string }[] }) {
  return (
    <Card className="mt-4 p-0">
      <details className="group/all px-4 py-3">
        <summary className={SUMMARY}>
          <Icon name="chevron" className={`${CHEVRON} group-open/all:rotate-90`} />
          Explore the example source
        </summary>
        <div className="mt-3 flex flex-col divide-y divide-separator">
          {sources.map((source) => (
            <details key={source.path} className="group/file py-2">
              <summary className={SUMMARY}>
                <Icon name="chevron" className={`${CHEVRON} group-open/file:rotate-90`} />
                <code className="font-mono text-xs">{source.path}</code>
              </summary>
              <Prose html={source.html} className="mt-2 text-xs" />
            </details>
          ))}
        </div>
      </details>
    </Card>
  )
}
