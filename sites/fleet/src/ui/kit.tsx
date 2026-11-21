/**
 * The few pieces of markup that mean the same thing on every screen of the dashboard, composed
 * from HeroUI and the shared Mockingbird components. Every link is an ordinary `<a href>`;
 * `followLinks` (runtime.ts) follows the ones that stay inside the dashboard.
 */
import { EmptyState, PageHeader } from "@crvouga/mockingbird-ui/react"
import { ChevronRight } from "@gravity-ui/icons"
import { Alert, Breadcrumbs, Button, buttonVariants, Card, Chip, Link } from "@heroui/react"
import { type ReactNode, useEffect, useState } from "react"
import { to } from "./routes.js"
import { lastApplied, ui } from "./runtime.js"
import type { Org } from "./types.js"

export type Child = ReactNode

/** An inline link in running text. */
export const A = ({ href, children, ...rest }: { href: string; children: ReactNode } & Aria) => (
  <Link href={href} {...rest}>
    {children}
  </Link>
)

type Aria = { "aria-label"?: string; title?: string; "data-cancel"?: string }

/** How strongly a link that looks like a button asks to be followed. */
export type ActionKind = "primary" | "plain" | "danger"

const VARIANT = { primary: "primary", plain: "secondary", danger: "danger" } as const

/** A link that looks like a button: the one obvious next step on a query screen. */
export const ActionLink = ({
  href,
  kind = "plain",
  size = "md",
  children,
}: {
  href: string
  kind?: ActionKind
  size?: "sm" | "md"
  children: ReactNode
}) => (
  <a
    href={href}
    data-action={kind}
    className={`${buttonVariants({ variant: VARIANT[kind], size })} no-underline`}
  >
    {children}
  </a>
)

/** `action(href, label, kind)`: an `ActionLink`, for the places a screen offers one. */
export const action = (href: string, label: ReactNode, kind: ActionKind = "plain") => (
  <ActionLink href={href} kind={kind}>
    {label}
  </ActionLink>
)

/** `mockingbird.yaml`, in code type. */
export const Code = ({ children }: { children: ReactNode }) => (
  <code className="rounded bg-default px-1 py-0.5 font-mono text-[0.9em] break-all">
    {children}
  </code>
)
export const FILE = "mockingbird.yaml"
export const File = () => <Code>{FILE}</Code>

/** Breadcrumb trail; the last item is the current page and is not a link. */
export function Crumbs({ items }: { items: (Crumb | false | null | undefined)[] }) {
  const shown = items.filter((item): item is Crumb => Boolean(item))
  return (
    <nav aria-label="Breadcrumb" className="mb-3 min-w-0">
      <Breadcrumbs
        className="flex-wrap text-sm"
        separator={
          <span aria-hidden="true" className="px-1 text-muted">
            /
          </span>
        }
      >
        {shown.map((item, index) =>
          index < shown.length - 1 && typeof item !== "string" ? (
            <Breadcrumbs.Item key={item.href} href={item.href}>
              {item.label}
            </Breadcrumbs.Item>
          ) : (
            <Breadcrumbs.Item key={`current: ${typeof item === "string" ? item : item.label}`}>
              {() => (
                <span aria-current="page" className="text-muted">
                  {typeof item === "string" ? item : item.label}
                </span>
              )}
            </Breadcrumbs.Item>
          ),
        )}
      </Breadcrumbs>
    </nav>
  )
}
export type Crumb = string | { href: string; label: string }

/** The top of a screen: its heading, a sentence about it, and its one obvious action. */
export const Head = ({
  title,
  sub,
  actions,
}: {
  title: ReactNode
  sub?: ReactNode
  actions?: ReactNode
}) => <PageHeader title={title} description={sub} actions={actions || undefined} />

/** A section of a query screen: a heading, optionally its action and a sentence, then its content. */
export const Section = ({
  title,
  actions,
  sub,
  children,
}: {
  title: string
  actions?: ReactNode
  sub?: ReactNode
  children?: ReactNode
}) => (
  <section className="mt-10 flex flex-col gap-4">
    <div className="-mb-6">
      <PageHeader level={2} title={title} description={sub} actions={actions || undefined} />
    </div>
    {children}
  </section>
)

/** A sentence under a heading or before a list. */
export const Sub = ({ children }: { children: ReactNode }) => (
  <p className="max-w-prose text-sm text-muted">{children}</p>
)

/** "Created just now", beside the thing a mutation just changed; nothing when it was not this. */
export const JustNow = ({ about }: { about: string }) =>
  ui.note?.about === about ? (
    <Chip size="sm" variant="soft" color="success" role="status" className="ml-2 align-middle">
      <Chip.Label>{ui.note.text}</Chip.Label>
    </Chip>
  ) : null

/** What a list says when something was just taken out of it. */
export const Removed = ({ about }: { about: string }) =>
  ui.note?.about === about ? (
    <p className="text-sm">
      <JustNow about={about} />
    </p>
  ) : null

export type Property = {
  name: string
  value: ReactNode
  about?: string
  change?: ReactNode
}

/**
 * The current settings of a thing, as labelled values. Each row may carry the link to the screen
 * that changes it; a query screen never changes a value in place.
 */
export const Properties = ({
  label,
  rows,
}: {
  label: string
  rows: (Property | false | null | undefined)[]
}) => (
  <dl
    aria-label={label}
    className="grid grid-cols-1 gap-x-6 text-sm sm:grid-cols-[minmax(9rem,max-content)_minmax(0,1fr)_auto]"
  >
    {rows.map((row) =>
      row ? (
        <div
          key={row.name}
          data-prop=""
          className="grid grid-cols-subgrid items-baseline gap-y-1 border-b border-separator py-2.5 last:border-b-0 sm:col-span-3"
        >
          <dt className="text-muted">{row.name}</dt>
          <dd className="m-0 min-w-0 break-words text-foreground">
            {row.value}
            {row.about ? <JustNow about={row.about} /> : null}
          </dd>
          {row.change ? <dd className="m-0 sm:text-right">{row.change}</dd> : null}
        </div>
      ) : null,
    )}
  </dl>
)

/** Text beside a value that qualifies it: "Permanent", "you". */
export const Aside = ({ children }: { children: ReactNode }) => (
  <span className="ml-2 text-xs text-muted">{children}</span>
)

/** A short label on a row: a role, a count, a category. */
export const Tag = ({ children, title }: { children: ReactNode; title?: string }) => (
  <Chip size="sm" variant="soft" {...(title ? { title } : {})}>
    <Chip.Label>{children}</Chip.Label>
  </Chip>
)

/** A list of links to other screens, one row each. */
export const LinkList = ({
  label,
  children,
  framed = true,
}: {
  label: string
  children: ReactNode
  /** In a card of its own; inside one already, a bordered list. */
  framed?: boolean
}) => {
  const list = (
    <ul
      className={`m-0 flex list-none flex-col divide-y divide-separator p-0 ${framed ? "" : "overflow-hidden rounded-lg border border-border"}`}
    >
      {children}
    </ul>
  )
  return (
    <nav aria-label={label}>
      {framed ? <Card className="gap-0 overflow-hidden p-0">{list}</Card> : list}
    </nav>
  )
}

/** One row of a `LinkList`: a title, a line under it, and tags on the right. */
export const LinkRow = ({
  href,
  title,
  meta,
  tags,
  mono = false,
}: {
  href: string
  title: ReactNode
  meta?: ReactNode
  tags?: ReactNode
  mono?: boolean
}) => (
  <li>
    <a
      href={href}
      className="flex items-center gap-3 px-4 py-3 text-foreground no-underline outline-none transition-colors hover:bg-default focus-visible:bg-default focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-inset"
    >
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="font-medium">{title}</span>
        {meta ? (
          <span className={`text-sm break-words text-muted ${mono ? "font-mono text-xs" : ""}`}>
            {meta}
          </span>
        ) : null}
      </span>
      {tags ? <span className="flex shrink-0 flex-wrap justify-end gap-1.5">{tags}</span> : null}
      <ChevronRight aria-hidden="true" className="size-4 shrink-0 text-muted" />
    </a>
  </li>
)

/** Nothing here yet, and what would fill it. */
export const Empty = ({
  title,
  children,
  action,
}: {
  title: ReactNode
  children?: ReactNode
  action?: ReactNode
}) => (
  <Card className="p-0">
    <EmptyState title={title} description={children} action={action} />
  </Card>
)

/** A note above or beside what it is about. Not an alert: it does not announce itself. */
export const Notice = ({
  tone = "accent",
  children,
}: {
  tone?: "accent" | "warning" | "danger"
  children: ReactNode
}) => (
  <Alert status={tone} className="mb-6">
    <Alert.Indicator />
    <Alert.Content>
      <p className="text-sm">{children}</p>
    </Alert.Content>
  </Alert>
)

/**
 * Said once on a screen that shows what the organization's `mockingbird.yaml` declares: it is
 * read-only here, and where to change it. Nothing when the organization is configured by hand.
 */
export const ManagedNotice = ({ org, readOnly }: { org: Org | undefined; readOnly: string }) =>
  org?.managed ? (
    <Notice>
      <strong>
        Configured by <File />.
      </strong>{" "}
      {readOnly} {lastApplied(org.managed)}{" "}
      <A href={to("org.configuration", { org: org.id })}>How to change it</A>
    </Notice>
  ) : null

/** Above a form that creates something by hand: the file is the prescribed way. */
export const PreferFile = ({ orgId, what }: { orgId: string; what: string }) => (
  <Notice>
    <strong>
      Prefer <File />:
    </strong>{" "}
    declare {what} in the file and apply it, and your repository holds the configuration.{" "}
    <A href={to("org.configuration", { org: orgId })}>Use {FILE} instead</A>
  </Notice>
)

/** In an empty list: the prescribed way to fill it, ahead of doing it by hand. */
export const DeclareIt = ({
  title,
  orgId,
  what,
  aside,
}: {
  title: string
  orgId: string
  what: string
  aside: string
}) => (
  <Empty
    title={title}
    action={action(
      to("org.configuration", { org: orgId }),
      "Start from mockingbird.yaml",
      "primary",
    )}
  >
    <span className="block">
      Declare {what} in <File /> and apply it.
    </span>
    <span className="mt-1 block">{aside}</span>
  </Empty>
)

/** A button that acts on this page only (copy a value, download a file); it changes nothing on the server. */
export const LocalButton = ({
  local,
  label,
  onPress,
  children,
  size = "sm",
  variant = "secondary",
}: {
  local: "copy" | "download"
  label?: string
  onPress: () => void
  children: ReactNode
  size?: "sm" | "md"
  variant?: "secondary" | "ghost" | "tertiary"
}) => (
  <Button
    type="button"
    data-local={local}
    size={size}
    variant={variant}
    onPress={onPress}
    {...(label ? { "aria-label": label } : {})}
  >
    {children}
  </Button>
)

/** A button that copies `text`, and says so for a moment. */
export function CopyButton({ text, label, what }: { text: string; label: string; what?: string }) {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 1500)
    return () => clearTimeout(timer)
  }, [copied])
  return (
    <LocalButton
      local="copy"
      {...(what ? { label: `Copy ${what}` } : {})}
      onPress={() => {
        void navigator.clipboard
          ?.writeText(text)
          .catch(() => {})
          .then(() => setCopied(true))
      }}
    >
      {copied ? "Copied" : label}
    </LocalButton>
  )
}

/** A value with a button that copies it. Copying changes nothing on the server. */
export const Copyable = ({ value, label = "Copy" }: { value: string; label?: string }) => (
  <span data-copy="" className="flex min-w-0 flex-wrap items-center gap-2">
    <code
      title={value}
      className="min-w-0 rounded-md border border-border bg-surface-secondary px-2 py-1 font-mono text-[13px] break-all"
    >
      {value}
    </code>
    <CopyButton text={value} label={label} />
  </span>
)

/** Save `text` as a file on this machine. */
export function saveFile(name: string, text: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type }))
  const anchor = document.createElement("a")
  anchor.href = url
  anchor.download = name
  anchor.click()
  URL.revokeObjectURL(url)
}

/** A button that saves `text` as a file. */
export const DownloadButton = ({ text, name }: { text: string; name: string }) => (
  <LocalButton
    local="download"
    label={`Download ${name}`}
    variant="ghost"
    onPress={() => saveFile(name, text, "application/yaml")}
  >
    Download
  </LocalButton>
)

/** Narrow content: a mutation, a result shown once, a statement. */
export const Narrow = ({ children }: { children: ReactNode }) => (
  <div className="mx-auto flex w-full max-w-2xl flex-col">{children}</div>
)

/** The links of a statement or a result: the ways on from here. */
export const Links = ({ children }: { children: ReactNode }) => (
  <div className="mt-6 flex flex-wrap items-center gap-2">{children}</div>
)
