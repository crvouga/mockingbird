/**
 * The in-process checkout quick start: its three files in HeroUI Tabs, each a description over
 * the file's code (a shared code frame from the markdown renderer). Hydrate it (`client:visible`);
 * without JavaScript it shows the first file.
 */
import { StatusChip } from "@crvouga/mockingbird-ui/react"
import { Card, Tabs } from "@heroui/react"
import { Icon } from "../icon.tsx"

export type QuickStartStep = {
  id: string
  title: string
  file: string
  description: string
  html: string
}

export function QuickStartTabs({ steps }: { steps: QuickStartStep[] }) {
  return (
    <Card className="gap-0 overflow-hidden p-0">
      <Tabs aria-label="Checkout quick start" defaultSelectedKey={steps[0]?.id}>
        <Tabs.ListContainer className="border-b border-separator bg-surface-secondary px-2 pt-2">
          <Tabs.List aria-label="Checkout quick start">
            {steps.map((step, i) => (
              <Tabs.Tab key={step.id} id={step.id} className="gap-2">
                <span className="font-mono text-[11px] text-muted">0{i + 1}</span> {step.title}
                <Tabs.Indicator />
              </Tabs.Tab>
            ))}
          </Tabs.List>
        </Tabs.ListContainer>
        {steps.map((step) => (
          <Tabs.Panel key={step.id} id={step.id} className="px-4 pt-4 pb-0 sm:px-5">
            <div className="flex items-center gap-2 font-mono text-xs text-muted">
              <Icon name="file" className="size-3.5" />
              <span className="truncate">{step.file}</span>
            </div>
            <p className="mt-2 text-sm text-muted">{step.description}</p>
            <div className="[&_figure]:mb-4" dangerouslySetInnerHTML={{ __html: step.html }} />
          </Tabs.Panel>
        ))}
      </Tabs>
      <div className="flex flex-wrap items-center gap-2.5 border-t border-separator px-4 py-3.5 text-xs text-muted sm:px-5">
        <Icon name="check" className="size-4 text-success" />
        <code className="font-mono text-foreground">201 Created</code>
        <span>Payment confirmed. Order saved.</span>
        <span className="sm:ml-auto">
          <StatusChip status="ok">Zero network requests</StatusChip>
        </span>
      </div>
    </Card>
  )
}
