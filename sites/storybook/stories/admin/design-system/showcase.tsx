/**
 * Every shared component of the design system (packages/ui/src/react) beside the HeroUI
 * components surfaces use directly, as one admin-like page and one single-purpose page. The
 * stories draw these the way each kind of surface does: server-rendered into `renderPage` for
 * pages served as strings, and mounted (hydrated) with `mount` for client-side surfaces.
 */

import {
  AppShell,
  CenteredCard,
  CodeBlock,
  EmptyState,
  ErrorState,
  JsonView,
  KeyValueList,
  LoadingState,
  PageHeader,
  StatusChip,
  ThemeSwitch,
} from "@crvouga/mockingbird-ui/react"
import { Plus } from "@gravity-ui/icons"
import { Button, Card, Input, Label, Table, Tabs, TextField } from "@heroui/react"

const CUSTOMERS = [
  { id: "cus_Q1a2", email: "ada@example.com", status: "ok", label: "Active" },
  { id: "cus_Q3b4", email: "grace@example.com", status: "warning", label: "Past due" },
  { id: "cus_Q5c6", email: "linus@example.com", status: "error", label: "Canceled" },
] as const

/** An admin-like screen: the shell, a page header, a table, details, code and every state. */
export function Showcase() {
  return (
    <AppShell
      product="Stripe"
      brandHref="#"
      nav={[
        { label: "Customers", href: "#customers", current: true },
        { label: "Payments", href: "#payments" },
        { label: "Webhooks", href: "#webhooks" },
        { label: "Journal", href: "#journal" },
      ]}
      actions={<ThemeSwitch />}
    >
      <PageHeader
        eyebrow="Resources"
        title="Customers"
        description="Every customer the emulator holds, newest first."
        actions={
          <>
            <Button variant="secondary" size="sm">
              Export
            </Button>
            <Button size="sm">
              <Plus className="size-4" />
              New customer
            </Button>
          </>
        }
      />
      <div className="grid gap-6 lg:grid-cols-[2fr_1fr]">
        <div className="flex min-w-0 flex-col gap-6">
          <Tabs aria-label="Filter">
            <Tabs.ListContainer>
              <Tabs.List aria-label="Filter">
                <Tabs.Tab id="all">All</Tabs.Tab>
                <Tabs.Tab id="active">Active</Tabs.Tab>
                <Tabs.Tab id="canceled">Canceled</Tabs.Tab>
              </Tabs.List>
            </Tabs.ListContainer>
          </Tabs>
          <Table>
            <Table.ScrollContainer>
              <Table.Content aria-label="Customers">
                <Table.Header>
                  <Table.Column isRowHeader>ID</Table.Column>
                  <Table.Column>Email</Table.Column>
                  <Table.Column>Status</Table.Column>
                </Table.Header>
                <Table.Body>
                  {CUSTOMERS.map((customer) => (
                    <Table.Row key={customer.id} id={customer.id}>
                      <Table.Cell className="font-mono text-[13px]">{customer.id}</Table.Cell>
                      <Table.Cell>{customer.email}</Table.Cell>
                      <Table.Cell>
                        <StatusChip status={customer.status}>{customer.label}</StatusChip>
                      </Table.Cell>
                    </Table.Row>
                  ))}
                </Table.Body>
              </Table.Content>
            </Table.ScrollContainer>
          </Table>
          <JsonView
            label="GET /v1/customers/cus_Q1a2"
            value={{
              id: "cus_Q1a2",
              object: "customer",
              email: "ada@example.com",
              livemode: false,
            }}
          />
          <CodeBlock
            label="Shell"
            code={"curl https://stripe.mock/v1/customers \\\n  -u sk_test_123:"}
          />
        </div>
        <div className="flex min-w-0 flex-col gap-6">
          <Card>
            <Card.Header>
              <Card.Title>cus_Q1a2</Card.Title>
              <Card.Description>Created by the seed script</Card.Description>
            </Card.Header>
            <Card.Content>
              <KeyValueList
                items={[
                  { label: "Email", value: "ada@example.com" },
                  { label: "Balance", value: "$0.00" },
                  { label: "Created", value: "2026-11-21T09:30:00Z", mono: true },
                  {
                    label: "Status",
                    value: (
                      <StatusChip status="ok" dot>
                        Active
                      </StatusChip>
                    ),
                  },
                ]}
              />
            </Card.Content>
          </Card>
          <div className="flex flex-wrap gap-2">
            <StatusChip status="ok">ok</StatusChip>
            <StatusChip status="warning">warning</StatusChip>
            <StatusChip status="error">error</StatusChip>
            <StatusChip status="info">info</StatusChip>
            <StatusChip status="neutral">neutral</StatusChip>
          </div>
          <Card>
            <EmptyState
              title="No webhooks yet"
              description="Add an endpoint and the emulator delivers every event to it."
              action={
                <Button size="sm" variant="secondary">
                  Add endpoint
                </Button>
              }
            />
          </Card>
          <ErrorState error={new Error("connect ECONNREFUSED 127.0.0.1:5432")} onRetry={() => {}} />
          <Card>
            <LoadingState label="Loading events…" />
          </Card>
        </div>
      </div>
    </AppShell>
  )
}

/** A single-purpose page: a sign-in form that posts without JavaScript. */
export function SignIn() {
  return (
    <CenteredCard
      product="Google"
      title="Sign in"
      description="to continue to Acme Notes"
      notice="A Mockingbird emulator: no real account is used."
    >
      <form method="post" action="/o/oauth2/v2/auth" className="flex flex-col gap-4">
        <TextField name="email" type="email" isRequired>
          <Label>Email</Label>
          <Input placeholder="ada@example.com" />
        </TextField>
        <Button type="submit" fullWidth>
          Continue
        </Button>
      </form>
    </CenteredCard>
  )
}
