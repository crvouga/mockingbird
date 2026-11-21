import { CodeBlock, Logo, MOCKINGBIRD, PageHeader, StatusChip } from "@crvouga/mockingbird-ui/react"
import { Card } from "@heroui/react"
import { ButtonLink, FactChip, FeaturedChip, Section, TextLink } from "./primitives.tsx"

const SWATCHES = [
  { name: "Background", token: "--background", note: "Page surface" },
  { name: "Surface", token: "--surface", note: "Cards, tables and code" },
  { name: "Foreground", token: "--foreground", note: "Headings and body text" },
  { name: "Muted", token: "--muted", note: "Secondary labels" },
  { name: "Accent", token: "--accent", note: "Actions, links and the current page" },
  { name: "Border", token: "--border", note: "Panel and table dividers" },
  { name: "Success", token: "--success", note: "Verified, supported, running" },
  { name: "Warning", token: "--warning", note: "Partial, pending" },
  { name: "Danger", token: "--danger", note: "Errors and destructive actions" },
] as const

/**
 * The design system page: the mark, the theme's tokens (live, so they follow the theme switch),
 * type, and the components every Mockingbird surface shares.
 */
export function Identity() {
  return (
    <>
      <PageHeader
        eyebrow="Developer documentation / Design system"
        title="Technical by design."
        description="Clear interfaces for exploring APIs, inspecting state, and understanding emulator coverage. Every Mockingbird surface (this site, the admin, Fleet Cloud, the example apps and the pages emulators serve) is React and HeroUI on one theme."
      />
      <Card>
        <Card.Content className="flex flex-row items-center gap-5 p-2 sm:p-4">
          <Logo size={64} />
          <div className="min-w-0">
            <h2 className="text-2xl font-semibold tracking-tight">{MOCKINGBIRD.name}</h2>
            <p className="mt-1 text-muted">{MOCKINGBIRD.tagline}</p>
            <TextLink href="/docs/design" arrow className="mt-3">
              Read the design guide
            </TextLink>
          </div>
        </Card.Content>
      </Card>

      <Section
        eyebrow="Color tokens"
        title="Neutral surfaces. Blue actions. Semantic status."
        description="These swatches read the live theme. Switch light, dark or system in the top bar."
      >
        <ul className="m-0 grid list-none grid-cols-1 gap-4 p-0 sm:grid-cols-2 lg:grid-cols-3">
          {SWATCHES.map((swatch) => (
            <li key={swatch.token}>
              <Card className="h-full flex-row items-center gap-4">
                <span
                  aria-hidden="true"
                  className="size-12 shrink-0 rounded-md border border-border"
                  style={{ background: `var(${swatch.token})` }}
                />
                <div className="min-w-0">
                  <strong className="block text-sm">{swatch.name}</strong>
                  <code className="block font-mono text-xs text-muted">{swatch.token}</code>
                  <p className="mt-1 text-xs text-muted">{swatch.note}</p>
                </div>
              </Card>
            </li>
          ))}
        </ul>
      </Section>

      <Section
        eyebrow="Typography"
        title="Readable documentation, familiar developer tools."
        description="The system sans-serif for headings and interface text, the system monospace for code, routes and technical labels. No web fonts."
      >
        <Card>
          <Card.Content className="gap-4">
            <p className="text-3xl font-semibold tracking-tight">{MOCKINGBIRD.tagline}</p>
            <p className="text-muted">
              System sans-serif for headings and interface text. System monospace for code, routes,
              and technical labels.
            </p>
            <CodeBlock label="HTTP" code="POST /v1/customers → 200 OK" copyable={false} />
          </Card.Content>
        </Card>
      </Section>

      <Section
        eyebrow="Interface components"
        title="Consistent controls for every emulator."
        description="HeroUI components on the shared theme: one border, restrained corners, and explicit status labels keep the documentation focused on behavior."
      >
        <Card>
          <Card.Content className="flex flex-row flex-wrap items-center gap-3">
            <ButtonLink href="/services" variant="primary" arrow>
              Explore emulators
            </ButtonLink>
            <ButtonLink href="/docs">Read documentation</ButtonLink>
            <StatusChip status="ok" dot>
              Verified sample
            </StatusChip>
            <StatusChip status="warning">Partial coverage</StatusChip>
            <StatusChip status="error">Not emulated</StatusChip>
            <FactChip>In-process fetch</FactChip>
            <FeaturedChip />
          </Card.Content>
        </Card>
      </Section>
    </>
  )
}
