import { Logo, MOCKINGBIRD } from "@crvouga/mockingbird-ui/react"
import { Chip } from "@heroui/react"

/**
 * The link-preview card (1200×630), drawn from the shared copy in the dark theme's tokens.
 * `public/identity/social-card.png` is a screenshot of it (docs/DESIGN.md). X overlays the page
 * title on the bottom-left corner, so that corner stays empty: the runtimes sit on the right.
 */
export function SocialCard({
  width,
  height,
  host,
  lead,
  accent,
  summary,
  runtimes,
}: {
  width: number
  height: number
  host: string
  lead: string
  accent: string
  summary: string
  runtimes: string[]
}) {
  return (
    <main
      className="flex flex-col overflow-hidden bg-background px-20 py-16 font-sans text-foreground"
      style={{ width, height }}
    >
      <header className="flex items-center justify-between">
        <span className="inline-flex items-center gap-4 text-[34px] font-semibold tracking-tight">
          <Logo size={52} />
          {MOCKINGBIRD.name}
        </span>
        <span className="font-mono text-[22px] text-muted">{host}</span>
      </header>
      <div className="my-auto">
        <p className="mb-6 flex items-center gap-3.5 font-mono text-xl tracking-[0.14em] text-muted uppercase">
          <span aria-hidden="true" className="size-3 rounded-full bg-success" />
          API &amp; database emulation
        </p>
        <h1 className="text-[96px] leading-[1.02] font-semibold tracking-[-0.045em]">
          {lead}
          <br />
          <span className="text-accent">{accent}</span>
        </h1>
        <p className="mt-7 max-w-[60rem] text-[27px] leading-snug text-muted">{summary}</p>
      </div>
      <ul className="m-0 flex list-none justify-end gap-2.5 p-0">
        {runtimes.map((runtime) => (
          <li key={runtime}>
            <Chip
              variant="secondary"
              className="border border-border px-3.5 py-1.5 font-mono text-[19px]"
            >
              <Chip.Label>{runtime}</Chip.Label>
            </Chip>
          </li>
        ))}
      </ul>
    </main>
  )
}
