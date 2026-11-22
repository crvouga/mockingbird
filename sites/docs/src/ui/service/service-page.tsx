import { PageHeader, StatusChip } from "@crvouga/mockingbird-ui/react"
import { Alert, buttonVariants, Card, Meter, Table } from "@heroui/react"
import { Fragment, type ReactNode } from "react"
import { CATEGORIES, type CategorySlug } from "../../lib/categories.ts"
import { percent } from "../../lib/format.ts"
import type { Service } from "../../lib/types.ts"
import { Icon } from "../icon.tsx"
import {
  ButtonLink,
  Crumbs,
  FactChip,
  FeaturedChip,
  Monogram,
  Section,
  TextLink,
  Toc,
} from "../primitives.tsx"
import { MethodChip } from "./method.tsx"

const categoryLabel = (slug: string) => CATEGORIES[slug as CategorySlug]?.label ?? slug

/**
 * The top of an emulator's page: where it sits in the catalog, what it emulates, its surfaces,
 * how to install it, and its links. `install` is the Install island, passed from the page.
 */
export function ServiceHeader({
  service: s,
  fleet,
  install,
}: {
  service: Service
  fleet: { package: string; configFile: string }
  install?: ReactNode
}) {
  const host = new URL(s.brand.website).hostname.replace(/^www\./, "")
  return (
    <header className="flex flex-col gap-5 border-b border-separator pb-10">
      <Crumbs
        items={[
          { label: "Emulators", href: "/services" },
          { label: categoryLabel(s.category), href: `/services?category=${s.category}` },
          { label: s.displayName },
        ]}
      />
      <div className="flex items-start gap-4">
        <Monogram name={s.displayName} logo={s.brand.logo} size="lg" />
        <div className="min-w-0 flex-1 [&_[data-mockingbird-page-header]]:mb-0">
          <PageHeader
            title={s.displayName}
            eyebrow={<code className="font-mono text-xs">{s.packageName}</code>}
            description={s.description}
          />
        </div>
      </div>
      <Card className="max-w-3xl" aria-label={`About ${s.brand.vendor}`}>
        <Card.Content className="flex flex-col gap-2 text-sm">
          <p className="text-muted">
            <strong className="font-semibold text-foreground">Emulates {s.brand.vendor}.</strong>
            {s.brand.description ? ` ${s.brand.description}` : ""}
          </p>
          <div className="flex flex-wrap gap-x-4 gap-y-1">
            <TextLink href={s.brand.website} external>
              <Icon name="globe" className="size-3.5" /> {host}
            </TextLink>
            {s.brand.docs ? (
              <TextLink href={s.brand.docs} external>
                <Icon name="file" className="size-3.5" /> API reference
              </TextLink>
            ) : null}
          </div>
        </Card.Content>
      </Card>
      <div className="flex flex-wrap gap-1.5">
        {s.featured ? <FeaturedChip /> : null}
        <FactChip>Parity: {s.parity}</FactChip>
        <FactChip color="accent">{categoryLabel(s.category)}</FactChip>
        {s.opsTotal > 0 ? (
          <FactChip>
            {s.opsSupported} of {s.opsTotal} operations
          </FactChip>
        ) : null}
        {s.surfaces.inProcess ? <FactChip>In-process fetch</FactChip> : null}
        {s.surfaces.server ? <FactChip>Node server</FactChip> : null}
        {s.surfaces.cli ? (
          <FactChip>
            <code className="font-mono">{s.surfaces.cli}</code>
          </FactChip>
        ) : null}
      </div>
      {s.surfaces.server ? (
        <Alert className="max-w-3xl">
          <Alert.Indicator>
            <Icon name="layers" />
          </Alert.Indicator>
          <Alert.Content>
            <Alert.Title>Recommended: run it in a fleet</Alert.Title>
            <Alert.Description className="[&_code]:font-mono [&_code]:text-[0.85em]">
              Install <code>{fleet.package}</code> next to this package, add <code>{s.name}</code>{" "}
              to the <code>services</code> of your <code>{fleet.configFile}</code>, and start every
              emulator with{" "}
              <code>npx mockingbird-fleet serve --config {fleet.configFile} --dashboard</code>.{" "}
              <TextLink href="/docs/fleets">Fleets guide</TextLink>
            </Alert.Description>
          </Alert.Content>
        </Alert>
      ) : null}
      <div className="flex flex-wrap items-end gap-3">
        {install ? <div className="min-w-0 flex-[1_1_24rem] sm:max-w-xl">{install}</div> : null}
        <div className="flex flex-wrap gap-2">
          <ButtonLink href={s.links.source} size="sm" icon="github" external>
            Source
          </ButtonLink>
          <ButtonLink href={s.links.npm} size="sm" icon="package" external>
            npm
          </ButtonLink>
          <ButtonLink href={`/services/${s.name}.md`} size="sm" icon="file">
            Markdown
          </ButtonLink>
          <ButtonLink href={s.links.discovery} size="sm" external>
            Agent discovery
          </ButtonLink>
          {s.links.support ? (
            <ButtonLink href={s.links.support} size="sm" external>
              SUPPORT.md
            </ButtonLink>
          ) : null}
        </div>
      </div>
    </header>
  )
}

/** The page body beside its table of contents (a right column on wide screens). */
export function ServiceLayout({
  toc,
  children,
}: {
  toc: { depth: number; slug: string; text: string }[]
  children?: ReactNode
}) {
  return (
    <div className="grid gap-14 pt-12 xl:grid-cols-[minmax(0,1fr)_13rem]">
      <div className="min-w-0">{children}</div>
      <Toc items={toc} />
    </div>
  )
}

/** Paths wrap only at "/", never inside a segment. */
const breakable = (path: string) =>
  path.split(/(?=\/)/).map((segment, i) => (
    // biome-ignore lint/suspicious/noArrayIndexKey: a path's segments are fixed.
    <Fragment key={i}>
      {i > 0 ? <wbr /> : null}
      {segment}
    </Fragment>
  ))

/**
 * Every operation in the vendored contract, emulated or not, with how much is covered. On an HTTP
 * emulator each emulated one has a Try button (`data-try-op`) that opens it in the playground.
 */
export function Operations({ service: s }: { service: Service }) {
  const p = percent(s.opsSupported, s.opsTotal)
  const gaps = s.operations.some((o) => !o.supported)
  return (
    <Section
      id="operations"
      title="Operations"
      description={`${s.opsSupported} of ${s.opsTotal} operations in the vendored contract are emulated.${s.contract.upstream ? ` ${s.contract.upstream}` : ""}`}
    >
      <Meter aria-label="Operations emulated" value={p} className="mb-4 w-full max-w-md" size="sm">
        <Meter.Track>
          <Meter.Fill />
        </Meter.Track>
      </Meter>
      <Table>
        <Table.ScrollContainer className="max-h-[32rem] overflow-auto">
          <Table.Content aria-label={`${s.displayName} operations`} className="min-w-[40rem]">
            <Table.Header className="sticky top-0 z-10">
              <Table.Column>Method</Table.Column>
              <Table.Column>Path</Table.Column>
              <Table.Column isRowHeader>Operation</Table.Column>
              <Table.Column>
                <span className="sr-only">Status</span>
              </Table.Column>
            </Table.Header>
            <Table.Body>
              {s.operations.map((o) => (
                <Table.Row key={o.id} id={o.id} data-unsupported={String(!o.supported)}>
                  <Table.Cell>
                    <MethodChip method={o.method} />
                  </Table.Cell>
                  <Table.Cell className="min-w-[12ch] font-mono text-xs">
                    <span className={o.supported ? "" : "text-muted"}>{breakable(o.path)}</span>
                  </Table.Cell>
                  <Table.Cell className="min-w-48">
                    <span
                      className={`block font-mono text-xs [overflow-wrap:anywhere] ${o.supported ? "" : "text-muted"}`}
                    >
                      {o.id}
                    </span>
                    {o.summary ? (
                      <span className="block text-xs text-muted">{o.summary}</span>
                    ) : null}
                  </Table.Cell>
                  <Table.Cell className="text-right whitespace-nowrap">
                    {o.supported ? (
                      s.kind === "http" ? (
                        <button
                          type="button"
                          data-try-op={o.id}
                          className={buttonVariants({ variant: "ghost", size: "sm" })}
                        >
                          Try
                        </button>
                      ) : null
                    ) : (
                      <StatusChip status="neutral">Not emulated</StatusChip>
                    )}
                  </Table.Cell>
                </Table.Row>
              ))}
            </Table.Body>
          </Table.Content>
        </Table.ScrollContainer>
      </Table>
      {gaps && s.links.support ? (
        <p className="mt-3 text-sm text-muted">
          Why each gap exists is recorded in{" "}
          <TextLink href={s.links.support} external>
            SUPPORT.md
          </TextLink>
          .
        </p>
      ) : null}
    </Section>
  )
}
