/**
 * The admin controls, one link per control page, grouped as `CONTROL_GROUPS` orders them. `full`
 * (the landing page, the hub) shows each control's call; `strip` is the one-line jump list at the
 * top of a control's own page.
 */
import { Card, Chip } from "@heroui/react"

export type ControlEntry = {
  group: string
  title: string
  call: string
  href: string
  slug: string
}

export function ControlDirectory({
  groups,
  current,
  variant = "full",
}: {
  groups: { title: string; entries: ControlEntry[] }[]
  /** The page being read, so its entry is marked. */
  current?: string
  variant?: "full" | "strip"
}) {
  if (variant === "strip") {
    return (
      <nav
        aria-label="Admin controls"
        className="mb-7 flex flex-wrap items-center gap-1.5 border-b border-separator pb-5"
      >
        <span className="mr-1 font-mono text-[11px] tracking-wider text-muted uppercase">
          Controls
        </span>
        {groups.flatMap((group) =>
          group.entries.map((entry) => {
            const on = entry.slug === current
            return (
              <a
                key={entry.href}
                href={entry.href}
                title={entry.call}
                {...(on ? { "aria-current": "page" as const } : {})}
                className="no-underline transition-opacity hover:opacity-80"
              >
                <Chip color={on ? "accent" : "default"} variant="soft" size="md">
                  <Chip.Label className={on ? "font-semibold" : ""}>{entry.title}</Chip.Label>
                </Chip>
              </a>
            )
          }),
        )}
      </nav>
    )
  }
  return (
    <nav aria-label="Admin controls" className="mb-2 flex flex-col gap-6">
      <p className="text-sm text-muted">
        Each control has its own page. The line under the name is the call that does it.
      </p>
      {groups.map((group) => (
        <section key={group.title}>
          <h3 className="mb-2 font-mono text-[11px] font-semibold tracking-wider text-muted uppercase">
            {group.title}
          </h3>
          <ul className="m-0 grid list-none grid-cols-[repeat(auto-fill,minmax(min(100%,15rem),1fr))] gap-2 p-0">
            {group.entries.map((entry) => {
              const on = entry.slug === current
              return (
                <li key={entry.href}>
                  <a
                    href={entry.href}
                    {...(on ? { "aria-current": "page" as const } : {})}
                    className="group block h-full text-foreground no-underline"
                  >
                    <Card
                      className={`h-full gap-1 p-3 transition-colors group-hover:bg-surface-secondary ${on ? "bg-accent-soft" : ""}`}
                    >
                      <strong className="text-sm font-semibold">{entry.title}</strong>
                      <code
                        className={`font-mono text-xs leading-snug break-all ${on ? "text-accent" : "text-muted"}`}
                      >
                        {entry.call}
                      </code>
                    </Card>
                  </a>
                </li>
              )
            })}
          </ul>
        </section>
      ))}
    </nav>
  )
}
