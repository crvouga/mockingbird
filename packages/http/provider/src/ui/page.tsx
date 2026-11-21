/**
 * Draws a `ProviderPage` (src/ui/model.ts) with the Mockingbird design system: `CenteredCard`
 * for sign-in, error and redirect pages, `AppShell` for the inspectors, the inbox and settings.
 * Every form posts natively, so the pages work without JavaScript.
 */
import {
  AppShell,
  CenteredCard,
  CodeBlock,
  EmptyState,
  ErrorState,
  JsonView,
  KeyValueList,
  PageHeader,
  StatusChip,
  ThemeSwitch,
} from "@crvouga/mockingbird-ui/react"
import { Check, ChevronRight } from "@gravity-ui/icons"
import { Avatar, Button, Card, Link, Table } from "@heroui/react"
import { Fragment, type ReactNode } from "react"
import type {
  AccountOption,
  Block,
  FormBlock,
  Inline,
  LinkItem,
  ProviderPage,
  Rich,
} from "./model.js"

/** The line under every sign-in card. */
export const NOTICE = "A Mockingbird emulator: no real account is used."

/** JSON this long is cut in a page, so a big store does not stall the browser. */
const JSON_PREVIEW_LIMIT = 65536

function inline(part: Inline, key: number): ReactNode {
  if (typeof part === "string") return <Fragment key={key}>{part}</Fragment>
  if ("strong" in part)
    return (
      <strong key={key} className="font-semibold text-foreground">
        {part.strong}
      </strong>
    )
  if ("code" in part)
    return (
      <code key={key} className="font-mono text-[13px]">
        {part.code}
      </code>
    )
  if ("link" in part)
    return (
      <Link key={key} href={part.href}>
        {part.link}
      </Link>
    )
  return (
    <StatusChip key={key} status={part.status ?? "neutral"}>
      {part.chip}
    </StatusChip>
  )
}

/** Inline content; chips sit in a wrapping row beside the text. */
export function RichText({ value }: { value: Rich | undefined }) {
  if (value === undefined) return null
  const parts = Array.isArray(value) ? value : [value]
  if (!parts.some((part) => typeof part === "object" && "chip" in part))
    return <>{parts.map(inline)}</>
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      {parts
        .filter((part) => part !== "" && part !== " ")
        .map((part, index) =>
          // biome-ignore lint/suspicious/noArrayIndexKey: a static page, never reordered.
          typeof part === "string" ? <span key={index}>{part}</span> : inline(part, index),
        )}
    </span>
  )
}

function HiddenFields({ fields }: { fields: Record<string, string> | undefined }) {
  return (
    <>
      {Object.entries(fields ?? {})
        .filter(([, value]) => value != null)
        .map(([name, value]) => (
          <input key={name} type="hidden" name={name} value={value} />
        ))}
    </>
  )
}

function Account({ account }: { account: AccountOption }) {
  return (
    <form method="post" action={account.formAction} data-testid="provider-account">
      <HiddenFields fields={account.hiddenFields} />
      <Button
        type="submit"
        variant="secondary"
        fullWidth
        className="user-btn h-auto justify-start gap-3 py-2 text-left"
      >
        <Avatar size="sm">
          <Avatar.Fallback>{account.letter}</Avatar.Fallback>
        </Avatar>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate font-medium text-foreground">{account.login}</span>
          {account.name ? (
            <span className="truncate text-xs text-muted">{account.name}</span>
          ) : null}
          {account.email && account.email !== account.login ? (
            <span className="truncate text-xs text-muted">{account.email}</span>
          ) : null}
        </span>
        <ChevronRight className="size-4 shrink-0 text-muted" />
      </Button>
    </form>
  )
}

function FormButton({ form }: { form: FormBlock }) {
  return (
    <form method="post" action={form.action}>
      <HiddenFields fields={form.fields} />
      <Button
        type="submit"
        size="sm"
        variant={
          form.variant === "danger"
            ? "danger-soft"
            : form.variant === "secondary"
              ? "secondary"
              : "primary"
        }
      >
        {form.label}
      </Button>
    </form>
  )
}

function LinkRow({ item }: { item: LinkItem }) {
  return (
    <a
      href={item.href}
      className="app-link flex min-w-0 items-center gap-3 px-4 py-3 text-foreground no-underline transition-colors hover:bg-default"
    >
      <Avatar size="sm">
        <Avatar.Fallback>{item.letter}</Avatar.Fallback>
      </Avatar>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate font-medium">{item.title}</span>
        {item.description ? (
          <span className="truncate text-xs text-muted">{item.description}</span>
        ) : null}
      </span>
      {item.status ? (
        <StatusChip status={item.status.status}>{item.status.label}</StatusChip>
      ) : null}
      <ChevronRight className="size-4 shrink-0 text-muted" />
    </a>
  )
}

function jsonPreview(value: unknown): unknown {
  const text = JSON.stringify(value, null, 2) ?? ""
  return text.length > JSON_PREVIEW_LIMIT
    ? `${text.slice(0, JSON_PREVIEW_LIMIT)}\n[remaining data omitted from preview]`
    : value
}

function BlockView({ block }: { block: Block }): ReactNode {
  switch (block.type) {
    case "accounts":
      return block.accounts.length === 0 ? (
        <EmptyState title={block.empty} />
      ) : (
        <div className="flex flex-col gap-2">
          {block.accounts.map((account, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: a static page, never reordered.
            <Account key={`${account.login}-${index}`} account={account} />
          ))}
        </div>
      )
    case "section":
      return (
        <section className="flex min-w-0 flex-col">
          <PageHeader
            level={2}
            title={
              <span className="inline-flex flex-wrap items-center gap-2">
                {block.title}
                {block.count === undefined ? null : (
                  <StatusChip status="neutral">{block.count}</StatusChip>
                )}
              </span>
            }
            description={
              block.description === undefined ? undefined : <RichText value={block.description} />
            }
            actions={block.action ? <FormButton form={block.action} /> : undefined}
          />
          <Blocks blocks={block.blocks} />
        </section>
      )
    case "table":
      return (
        <Table>
          <Table.ScrollContainer>
            <Table.Content aria-label={block.label}>
              <Table.Header>
                {block.columns.map((column, index) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: a static page, never reordered.
                  <Table.Column key={index} id={`c${index}`} isRowHeader={index === 0}>
                    {column}
                  </Table.Column>
                ))}
              </Table.Header>
              <Table.Body renderEmptyState={() => <EmptyState title={block.empty} />}>
                {block.rows.map((row, rowIndex) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: a static page, never reordered.
                  <Table.Row key={rowIndex} id={`r${rowIndex}`}>
                    {row.map((cell, cellIndex) => (
                      // biome-ignore lint/suspicious/noArrayIndexKey: a static page, never reordered.
                      <Table.Cell key={cellIndex} className="max-w-md break-words align-top">
                        <RichText value={cell} />
                      </Table.Cell>
                    ))}
                  </Table.Row>
                ))}
              </Table.Body>
            </Table.Content>
          </Table.ScrollContainer>
        </Table>
      )
    case "json":
      return <JsonView label={block.label} value={jsonPreview(block.value)} maxHeight="70vh" wrap />
    case "code":
      return <CodeBlock code={block.code} label={block.label} maxHeight="70vh" wrap />
    case "text":
      return (
        <p className="text-sm text-muted">
          <RichText value={block.text} />
        </p>
      )
    case "empty":
      return <EmptyState title={block.title} description={block.description} />
    case "details":
      return (
        <KeyValueList
          items={block.items.map((item, index) => ({
            id: `${item.label}-${index}`,
            label: item.label,
            value: <RichText value={item.value} />,
            mono: item.mono ?? false,
          }))}
        />
      )
    case "links":
      return block.items.length === 0 ? (
        <Card>
          <EmptyState title={block.empty} />
        </Card>
      ) : (
        <Card className="overflow-hidden p-0">
          <div className="flex flex-col divide-y divide-separator">
            {block.items.map((item) => (
              <LinkRow key={item.href} item={item} />
            ))}
          </div>
        </Card>
      )
    case "checklist":
      return block.items.length === 0 ? (
        <p className="text-sm text-muted">{block.empty}</p>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-2 p-0 text-sm">
          {block.items.map((item) => (
            <li key={item} className="flex items-center gap-2">
              <Check className="size-4 shrink-0 text-success" />
              {item}
            </li>
          ))}
        </ul>
      )
    case "chips":
      return (
        <div className="flex flex-wrap gap-2">
          {block.chips.map((chip, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: a static page, never reordered.
            <StatusChip key={`${chip.label}-${index}`} status={chip.status}>
              {chip.label}
            </StatusChip>
          ))}
        </div>
      )
    case "frame":
      return (
        <iframe
          title={block.title}
          sandbox="allow-popups allow-popups-to-escape-sandbox"
          srcDoc={`<meta name="color-scheme" content="light"><base target="_blank"><style>html{background:#fff}</style>${block.html}`}
          className="block min-h-80 w-full rounded-lg border border-border"
        />
      )
    case "form":
      return <FormButton form={block} />
  }
}

function Blocks({ blocks }: { blocks: Block[] }) {
  return (
    <div className="flex min-w-0 flex-col gap-4">
      {blocks.map((block, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: a static page, never reordered.
        <BlockView key={index} block={block} />
      ))}
    </div>
  )
}

/** A whole provider page, server-rendered by `server.tsx`. */
export function ProviderPageView({ page }: { page: ProviderPage }) {
  if (page.layout === "card")
    return (
      <CenteredCard
        product={page.service}
        title={page.title}
        description={
          page.description === undefined ? undefined : <RichText value={page.description} />
        }
        notice={NOTICE}
      >
        {page.error === undefined ? (
          <Blocks blocks={page.blocks} />
        ) : (
          <ErrorState title={page.error} />
        )}
      </CenteredCard>
    )
  const home = page.home ?? page.nav[0]?.href
  return (
    <AppShell
      {...(page.service ? { product: page.service } : {})}
      {...(home ? { brandHref: home } : {})}
      nav={page.nav}
      actions={<ThemeSwitch />}
    >
      <PageHeader
        title={page.heading ?? page.title}
        description={
          page.description === undefined ? undefined : <RichText value={page.description} />
        }
      />
      <div className="flex min-w-0 flex-col gap-10">
        {page.blocks.map((block, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: a static page, never reordered.
          <BlockView key={index} block={block} />
        ))}
      </div>
    </AppShell>
  )
}
