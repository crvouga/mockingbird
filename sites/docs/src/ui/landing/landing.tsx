/**
 * The landing page's blocks (src/pages/index.astro arranges them, with the islands between).
 * Built from HeroUI Cards, Chips and Table and the shared components, like every other page.
 */
import { StatusChip } from "@crvouga/mockingbird-ui/react"
import { Card, Chip, Table } from "@heroui/react"
import type { ReactNode } from "react"
import { CodeFrame } from "../code.tsx"
import { Icon, type IconName } from "../icon.tsx"
import { ButtonLink, FeatureCard, Html, IconTile, Monogram, TextLink } from "../primitives.tsx"

/** The status dot that marks something live. */
const Dot = () => <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-success" />

export function Hero({
  lead,
  accent,
  pitchHtml,
  install,
  config,
}: {
  lead: string
  accent: string
  pitchHtml: string
  /** The Install island, from the page. */
  install?: ReactNode
  config: { file: string; configHtml: string; serveHtml: string }
}) {
  return (
    <section className="grid grid-cols-1 items-center gap-8 py-6 md:py-10 lg:grid-cols-2 lg:gap-14">
      <div className="min-w-0">
        <p className="flex items-center gap-2 text-sm text-muted">
          <Dot /> API &amp; database emulation
        </p>
        <h1 className="mt-5 text-4xl leading-tight font-bold tracking-tight text-foreground sm:text-5xl">
          {lead}
          <br />
          <span className="text-accent">{accent}</span>
        </h1>
        <Html
          as="p"
          html={pitchHtml}
          className="mt-5 max-w-[54ch] text-base leading-relaxed text-muted [&_a]:text-link [&_code]:font-mono [&_code]:text-[0.85em]"
        />
        <div className="mt-7 flex flex-wrap gap-2.5">
          <ButtonLink href="/docs/getting-started" variant="primary" arrow>
            Get started
          </ButtonLink>
          <ButtonLink href="/services">Explore emulators</ButtonLink>
          <ButtonLink href="#admin-controls">Admin controls</ButtonLink>
          <ButtonLink href="#notifications" icon="bell">
            Notifications
          </ButtonLink>
        </div>
        <div className="mt-7 min-w-0">{install}</div>
        <p className="mt-3.5 font-mono text-[11px] text-muted">
          Node.js <span className="px-2 opacity-60">·</span> Bun{" "}
          <span className="px-2 opacity-60">·</span> Browser{" "}
          <span className="px-2 opacity-60">·</span> Workers
        </p>
      </div>
      <CodeFrame
        ariaLabel="A fleet configuration and the command that starts it"
        icon="file"
        label={config.file}
        badge={<StatusChip status="ok">Fleet</StatusChip>}
        html={config.configHtml}
      >
        <div className="flex items-center gap-2 border-y border-separator px-3 py-2 font-mono text-xs text-muted">
          <Icon name="terminal" className="size-3.5" /> terminal
        </div>
        <div className="[&_pre]:m-0 [&_pre]:overflow-x-auto [&_pre]:bg-transparent! [&_pre]:p-3 [&_pre]:font-mono [&_pre]:text-[13px] [&_pre]:leading-relaxed">
          <Html html={config.serveHtml} as="div" />
        </div>
        <div className="flex items-center gap-2 border-t border-separator px-3 py-2.5 font-mono text-[11px] text-muted">
          <Dot /> One process <span className="ml-auto hidden sm:inline">A port per emulator</span>
        </div>
      </CodeFrame>
    </section>
  )
}

export function Stats({ services, ops }: { services: number; ops: number }) {
  const items: { value: ReactNode; label: string; href?: string }[] = [
    { value: services, label: "service emulators", href: "/services" },
    { value: ops, label: "supported vendor operations", href: "/coverage" },
    { value: 4, label: "JavaScript runtimes" },
  ]
  return (
    <section aria-label="Emulator capabilities" className="grid grid-cols-1 gap-4 sm:grid-cols-3">
      {items.map((item) => {
        const body = (
          <Card
            key={item.label}
            className="h-full flex-row items-center gap-4 p-5 transition-colors group-hover:bg-surface-secondary"
          >
            <strong className="font-mono text-3xl font-semibold tracking-tight text-foreground">
              {item.value}
            </strong>
            <span className="text-xs text-muted">{item.label}</span>
          </Card>
        )
        return item.href ? (
          <a key={item.label} href={item.href} className="group block no-underline">
            {body}
          </a>
        ) : (
          <div key={item.label}>{body}</div>
        )
      })}
    </section>
  )
}

/** Code panels side by side (stacked on a narrow screen). */
export function CodePanels({
  panels,
}: {
  panels: { label: string; file: string; icon: IconName; html: string; ariaLabel: string }[]
}) {
  return (
    <div className="mb-4 grid grid-cols-1 gap-4 lg:grid-cols-3">
      {panels.map((panel) => (
        <CodeFrame
          key={panel.ariaLabel}
          ariaLabel={panel.ariaLabel}
          icon={panel.icon}
          label={panel.file}
          badge={
            <Chip color="accent" variant="soft" size="sm">
              <Chip.Label>{panel.label}</Chip.Label>
            </Chip>
          }
          html={panel.html}
        />
      ))}
    </div>
  )
}

export type Feature = {
  icon: string
  title: string
  html: string
  href?: string
  linkLabel?: string
}

export function FeatureGrid({ features, className }: { features: Feature[]; className?: string }) {
  return (
    <div
      className={`grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 ${className ?? ""}`.trim()}
    >
      {features.map((feature) => (
        <FeatureCard key={feature.title} {...feature} />
      ))}
    </div>
  )
}

/** A closing callout under a section: an icon, a point, and where to go next. */
export function Callout({
  icon,
  title,
  children,
  actions,
}: {
  icon: IconName
  title: string
  children: ReactNode
  actions: ReactNode
}) {
  return (
    <Card className="mt-4 flex-row flex-wrap items-center gap-5 bg-surface-secondary p-6">
      <IconTile name={icon} />
      <div className="min-w-0 flex-1 basis-72">
        <h3 className="text-base font-semibold">{title}</h3>
        <div className="mt-1.5 text-sm leading-relaxed text-muted [&_a]:text-link [&_code]:font-mono [&_code]:text-[0.85em]">
          {children}
        </div>
      </div>
      <div className="flex flex-wrap gap-2.5">{actions}</div>
    </Card>
  )
}

export function FleetSteps({ steps }: { steps: { title: string; html: string }[] }) {
  return (
    <ol className="my-6 grid list-decimal gap-2 pl-5 text-sm leading-relaxed text-muted marker:text-muted">
      {steps.map((step) => (
        <li key={step.title}>
          <strong className="text-foreground">{step.title}.</strong>{" "}
          <Html
            html={step.html}
            className="[&_a]:text-link [&_code]:font-mono [&_code]:text-[0.85em]"
          />
        </li>
      ))}
    </ol>
  )
}

export function Devices({
  channels,
}: {
  channels: { icon: string; title: string; services: string; body: string }[]
}) {
  return (
    <section
      aria-label="What each device shows"
      className="mb-4 grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4"
    >
      {channels.map((channel) => (
        <Card key={channel.title} className="h-full">
          <Card.Header className="flex-row items-center gap-3">
            <IconTile name={channel.icon} />
            <div>
              <Card.Title className="text-base font-semibold">{channel.title}</Card.Title>
              <Card.Description className="text-xs">{channel.services}</Card.Description>
            </div>
          </Card.Header>
          <Card.Content>
            <p className="text-sm leading-relaxed text-muted">{channel.body}</p>
          </Card.Content>
        </Card>
      ))}
    </section>
  )
}

export type CategorySummary = {
  slug: string
  label: string
  count: number
  blurb: string
  members: { name: string; displayName: string; logo: string | null }[]
}

export function Categories({ categories }: { categories: CategorySummary[] }) {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {categories.map((category) => (
        <a
          key={category.slug}
          href={`/services?category=${category.slug}`}
          className="group block text-foreground no-underline"
        >
          <Card className="h-full transition-colors group-hover:bg-surface-secondary">
            <Card.Header className="flex-row items-center justify-between gap-3">
              <Card.Title className="text-[15px] font-semibold">{category.label}</Card.Title>
              <span className="font-mono text-xs text-muted">{category.count}</span>
            </Card.Header>
            <Card.Content>
              <p className="text-sm text-muted">{category.blurb}</p>
            </Card.Content>
            <Card.Footer className="gap-2">
              {category.members.slice(0, 5).map((service) => (
                <Monogram
                  key={service.name}
                  name={service.displayName}
                  logo={service.logo}
                  size="sm"
                />
              ))}
            </Card.Footer>
          </Card>
        </a>
      ))}
    </div>
  )
}

export function FeaturedHeader() {
  return (
    <div className="mt-7 flex flex-wrap items-center justify-between gap-4">
      <h3 className="flex items-center gap-2 text-[15px] font-semibold">
        <Icon name="star-fill" className="size-4 text-accent" /> Featured emulators
      </h3>
      <TextLink href="/services?featured=1" arrow>
        View featured
      </TextLink>
      <p className="basis-full text-sm text-muted">
        Start with payments, SQL, object storage, or healthcare integrations. Open an emulator to
        explore its contract and try the playground.
      </p>
    </div>
  )
}

export function ContractTable({ rows }: { rows: [string, string][] }) {
  return (
    <Table>
      <Table.ScrollContainer>
        <Table.Content aria-label="Service interface">
          <Table.Header>
            <Table.Column isRowHeader>Interface</Table.Column>
            <Table.Column>Behavior</Table.Column>
          </Table.Header>
          <Table.Body>
            {rows.map(([surface, detail]) => (
              <Table.Row key={surface} id={surface}>
                <Table.Cell className="align-top [&_code]:font-mono [&_code]:text-[13px]">
                  <Html html={surface} />
                </Table.Cell>
                <Table.Cell className="align-top text-muted [&_a]:text-link [&_code]:font-mono [&_code]:text-[13px] [&_code]:text-foreground">
                  <Html html={detail} />
                </Table.Cell>
              </Table.Row>
            ))}
          </Table.Body>
        </Table.Content>
      </Table.ScrollContainer>
    </Table>
  )
}

const AGENT_LINKS: { href: string; icon: IconName; path: string; label: string }[] = [
  {
    href: "/llms.txt",
    icon: "bot",
    path: "/llms.txt",
    label: "Emulator index and declared parity",
  },
  {
    href: "/llms-full.txt",
    icon: "file",
    path: "/llms-full.txt",
    label: "Every package guide in one file",
  },
  {
    href: "/catalog.json",
    icon: "database",
    path: "/catalog.json",
    label: "Interfaces and operation coverage",
  },
  {
    href: "/services/stripe.md",
    icon: "file",
    path: "/services/<name>.md",
    label: "Raw markdown for each emulator",
  },
]

export function AgentDocs({ html }: { html: string }) {
  return (
    <Card className="grid grid-cols-1 gap-6 bg-surface-secondary p-6 md:grid-cols-2 md:gap-14 md:p-8">
      <div>
        <p className="text-sm text-muted">Machine-readable documentation</p>
        <h2 className="mt-2 text-2xl font-semibold tracking-tight">
          Source-backed guides for developers and agents.
        </h2>
        <Html
          as="p"
          html={html}
          className="mt-4 text-sm leading-relaxed text-muted [&_a]:text-link [&_code]:font-mono [&_code]:text-[0.85em]"
        />
      </div>
      <ul className="m-0 list-none divide-y divide-separator p-0">
        {AGENT_LINKS.map((link) => (
          <li key={link.href}>
            <a
              href={link.href}
              className="group flex items-center gap-3 py-3.5 text-muted no-underline"
            >
              <Icon name={link.icon} />
              <span className="min-w-0 flex-1 text-xs">
                <strong className="mb-1 block font-mono text-[13px] text-foreground group-hover:text-accent">
                  {link.path}
                </strong>
                {link.label}
              </span>
              <Icon name="arrow-right" />
            </a>
          </li>
        ))}
      </ul>
    </Card>
  )
}
