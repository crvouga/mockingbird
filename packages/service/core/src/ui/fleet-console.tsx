/**
 * The fleet console (`GET <adminPrefix>/ui` on the node adapter's fleet supervisor): admin key and
 * namespace, each child's admin link, namespace actions, and the fleet API's last answer. It talks
 * only to `<adminPrefix>/fleet`. Server-rendered by ./server.tsx and hydrated by ./client.tsx.
 */
import {
  AppShell,
  EmptyState,
  JsonView,
  PageHeader,
  StatusChip,
  ThemeSwitch,
} from "@crvouga/mockingbird-ui/react"
import { ArrowRotateRight, Camera, TrashBin } from "@gravity-ui/icons"
import { Alert, Button, Card, Input, Label, Link, Table, TextField } from "@heroui/react"
import { type FormEvent, useState } from "react"

export type FleetConsoleProps = {
  /** The fleet API, `<adminPrefix>/fleet`. */
  base: string
  /** The dashboard every emulator's admin UI is on, when the fleet was started with one. */
  dashboard?: string
  /** Stands in for the page's `fetch` (Storybook routes it to a recorded fleet). Not serializable. */
  fetch?: (input: string, init: RequestInit) => Promise<Response>
}

type Child = { name: string; protocol: string; adminUrl: string }
type Answer = { label: string; status: number; data: unknown }

const ADMIN_KEY_HEADER = "x-mockingbird-admin-key"

const childrenOf = (data: unknown): Child[] => {
  const services = (data as { manifest?: { services?: Record<string, unknown> } } | null)?.manifest
    ?.services
  if (!services || typeof services !== "object") return []
  return Object.entries(services).map(([name, child]) => {
    const value = (child ?? {}) as { protocol?: unknown; adminUrl?: unknown }
    return {
      name,
      protocol: typeof value.protocol === "string" ? value.protocol : "",
      adminUrl: typeof value.adminUrl === "string" ? value.adminUrl : "",
    }
  })
}

export function FleetConsole({ base, dashboard, fetch: fetcher }: FleetConsoleProps) {
  const [key, setKey] = useState("")
  const [namespace, setNamespace] = useState("default")
  const [children, setChildren] = useState<Child[] | undefined>(undefined)
  const [answer, setAnswer] = useState<Answer | undefined>(undefined)
  const [busy, setBusy] = useState(false)

  const api = async (path: string, method = "GET", body?: unknown): Promise<unknown> => {
    const response = await (fetcher ?? fetch)(base + path, {
      method,
      headers: { "content-type": "application/json", [ADMIN_KEY_HEADER]: key },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    const text = await response.text()
    let data: unknown = text
    try {
      data = JSON.parse(text)
    } catch {}
    setAnswer({
      label: `${method} ${path || "/"} · ${response.status}`,
      status: response.status,
      data,
    })
    return response.ok ? data : undefined
  }
  const run = async (task: () => Promise<unknown>) => {
    setBusy(true)
    try {
      await task()
    } catch (error) {
      setAnswer({ label: "Request failed", status: 0, data: String(error) })
    } finally {
      setBusy(false)
    }
  }
  const refresh = (event?: FormEvent) => {
    event?.preventDefault()
    void run(async () => {
      const data = await api("")
      if (data === undefined) return
      setChildren(childrenOf(data))
      await api(`/operations?namespace=${encodeURIComponent(namespace)}`)
    })
  }
  const act = (action: "snapshots" | "reset") =>
    run(() => api(`/namespaces/${encodeURIComponent(namespace)}/${action}`, "POST", {}))

  return (
    <AppShell product="Fleet" actions={<ThemeSwitch />}>
      <PageHeader
        title="Fleet console"
        description="The emulators this process supervises: their admin UIs, and checkpoints and resets per namespace."
      />
      <div className="flex flex-col gap-6">
        {dashboard ? (
          <Alert status="accent" id="dashboard">
            <Alert.Indicator />
            <Alert.Content>
              <Alert.Description>
                Every emulator's admin UI and the notifications UI are on the{" "}
                <Link href={dashboard}>dashboard</Link>.
              </Alert.Description>
            </Alert.Content>
          </Alert>
        ) : null}
        <Card>
          <Card.Header>
            <Card.Title>Connection</Card.Title>
            <Card.Description>
              Requests carry the admin key in <code className="font-mono">{ADMIN_KEY_HEADER}</code>.
            </Card.Description>
          </Card.Header>
          <Card.Content>
            <form onSubmit={refresh} className="grid items-end gap-4 sm:grid-cols-[1fr_1fr_auto]">
              <TextField name="key" type="password" value={key} onChange={setKey}>
                <Label>Admin key</Label>
                <Input autoComplete="off" data-testid="fleet-key" />
              </TextField>
              <TextField name="namespace" value={namespace} onChange={setNamespace}>
                <Label>Namespace</Label>
                <Input data-testid="fleet-namespace" />
              </TextField>
              <Button type="submit" isDisabled={busy} data-testid="fleet-refresh">
                <ArrowRotateRight className="size-4" />
                Refresh
              </Button>
            </form>
          </Card.Content>
        </Card>
        <section aria-labelledby="fleet-services" className="flex flex-col gap-3">
          <PageHeader level={2} title={<span id="fleet-services">Services</span>} />
          {children === undefined ? (
            <Card>
              <EmptyState
                title="Not loaded yet"
                description="Refresh with the admin key to list the fleet's emulators."
              />
            </Card>
          ) : children.length === 0 ? (
            <Card>
              <EmptyState title="No services" description="This fleet supervises no emulators." />
            </Card>
          ) : (
            <Table data-testid="fleet-children">
              <Table.ScrollContainer>
                <Table.Content aria-label="Services">
                  <Table.Header>
                    <Table.Column isRowHeader>Service</Table.Column>
                    <Table.Column>Protocol</Table.Column>
                    <Table.Column>Admin</Table.Column>
                  </Table.Header>
                  <Table.Body>
                    {children.map((child) => (
                      <Table.Row key={child.name} id={child.name}>
                        <Table.Cell className="font-medium">{child.name}</Table.Cell>
                        <Table.Cell>
                          <StatusChip status="neutral">{child.protocol}</StatusChip>
                        </Table.Cell>
                        <Table.Cell className="font-mono text-[13px]">
                          {child.adminUrl ? (
                            <Link href={child.adminUrl}>{child.adminUrl}</Link>
                          ) : (
                            "—"
                          )}
                        </Table.Cell>
                      </Table.Row>
                    ))}
                  </Table.Body>
                </Table.Content>
              </Table.ScrollContainer>
            </Table>
          )}
        </section>
        <section aria-labelledby="fleet-actions" className="flex flex-col gap-3">
          <PageHeader
            level={2}
            title={<span id="fleet-actions">Namespace actions</span>}
            description={`Run against namespace “${namespace}”.`}
            actions={
              <>
                <Button
                  variant="secondary"
                  isDisabled={busy}
                  onPress={() => void act("snapshots")}
                  data-testid="fleet-checkpoint"
                >
                  <Camera className="size-4" />
                  Capture checkpoint
                </Button>
                <Button
                  variant="danger-soft"
                  isDisabled={busy}
                  onPress={() => void act("reset")}
                  data-testid="fleet-reset"
                >
                  <TrashBin className="size-4" />
                  Reset namespace
                </Button>
              </>
            }
          />
        </section>
        <section aria-labelledby="fleet-result" className="flex flex-col gap-3">
          <PageHeader
            level={2}
            title={<span id="fleet-result">Lifecycle and operations</span>}
            actions={
              answer ? (
                <StatusChip status={answer.status >= 200 && answer.status < 300 ? "ok" : "error"}>
                  {answer.status || "failed"}
                </StatusChip>
              ) : null
            }
          />
          <div data-testid="fleet-answer">
            {answer ? (
              <JsonView label={answer.label} value={answer.data} maxHeight="30rem" wrap />
            ) : (
              <Card>
                <EmptyState
                  title="No requests yet"
                  description="The fleet API's answer to the last refresh or action appears here."
                />
              </Card>
            )}
          </div>
        </section>
      </div>
    </AppShell>
  )
}
