/**
 * Landing figure: the lab testing example, whose client, server, and every vendor it calls share
 * one browser tab. Rendered inside `<app-example>` (index.astro), whose launcher
 * (`client/appExamples.ts`) opens the example when `[data-example-open]` is pressed.
 */
import { buttonVariants, Card } from "@heroui/react"
import { Icon } from "../icon.tsx"
import { ButtonLink } from "../primitives.tsx"
import { VendorLogo } from "./vendor-logo.tsx"

export type StackVendor = { key: string; logo: string; name: string; role: string }

const MODES: [string, string][] = [
  ["Run it", "in this tab, with nothing to install"],
  ["Serve it", "with `bun run dev` behind a real port"],
  ["Test it", "with `bun test`, routes driven in-process"],
]

const code = (text: string) =>
  text.split(/`([^`]+)`/).map((part, i) =>
    i % 2 ? (
      // biome-ignore lint/suspicious/noArrayIndexKey: fixed copy.
      <code key={i} className="rounded bg-default px-1.5 py-0.5 font-mono text-[0.82em]">
        {part}
      </code>
    ) : (
      part
    ),
  )

/** A box in the diagram: the client or the server. */
function Layer({ kicker, title }: { kicker: string; title: string }) {
  return (
    <div className="grid gap-1 rounded-md border border-border bg-background px-4 py-3.5">
      <span className="text-[11px] font-semibold tracking-widest text-accent uppercase">
        {kicker}
      </span>
      <strong className="text-lg font-semibold">{title}</strong>
    </div>
  )
}

export function BrowserStack({
  title,
  host,
  slug,
  vendors,
}: {
  title: string
  /** The docs site's host, for the address bar. */
  host: string
  slug: string
  vendors: StackVendor[]
}) {
  return (
    <div className="grid grid-cols-1 items-center gap-8 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)] lg:gap-12">
      <figure
        className="m-0"
        aria-label={`${title}: client, server, and ${vendors.length} vendors in one browser tab`}
      >
        <Card className="gap-0 overflow-hidden p-0">
          <div
            aria-hidden="true"
            className="flex h-11 items-center gap-3.5 border-b border-separator bg-surface-secondary px-3.5"
          >
            <span className="font-mono font-semibold text-muted">&gt;_</span>
            <span className="min-w-0 flex-1 truncate rounded-md bg-background px-3 py-1 font-mono text-xs text-muted">
              {host}/examples/{slug}
            </span>
          </div>
          <div className="grid gap-6 px-4.5 py-6 sm:gap-9 sm:px-8 sm:py-9">
            <div className="grid grid-cols-1 items-center gap-3 sm:grid-cols-[minmax(0,1fr)_40px_minmax(0,1fr)] sm:gap-0">
              <Layer kicker="Client" title="Lab workspace UI" />
              <span aria-hidden="true" className="hidden border-t border-border sm:block" />
              <Layer kicker="Server" title="HTTP API" />
            </div>
            <ul className="m-0 grid list-none grid-cols-2 gap-x-3 gap-y-5 p-0 sm:grid-cols-4 sm:gap-3">
              {vendors.map((vendor) => (
                <li key={vendor.key} className="grid justify-items-center gap-0.5 text-center">
                  <VendorLogo logo={vendor.logo} size={44} />
                  <span className="mt-2 text-[13.5px] font-semibold">{vendor.name}</span>
                  <span className="text-xs text-muted">{vendor.role}</span>
                </li>
              ))}
            </ul>
          </div>
          <figcaption className="border-t border-separator px-4.5 py-3.5 text-[15px] text-accent sm:px-8">
            Everything above runs in this tab. No request leaves it.
          </figcaption>
        </Card>
      </figure>

      <div className="grid gap-7">
        <ul className="m-0 grid list-none divide-y divide-separator border-y border-separator p-0">
          {MODES.map(([verb, rest]) => (
            <li key={verb} className="py-3.5 text-[15px] text-muted">
              <strong className="text-lg font-semibold text-foreground">{verb}</strong> {code(rest)}
            </li>
          ))}
        </ul>
        <div className="flex flex-wrap gap-2.5">
          <button
            type="button"
            className={buttonVariants({ variant: "primary" })}
            data-example-open
            aria-haspopup="dialog"
          >
            <Icon name="play" /> Launch the app
          </button>
          <ButtonLink href={`/examples/${slug}`}>How it's built</ButtonLink>
        </div>
      </div>
    </div>
  )
}
