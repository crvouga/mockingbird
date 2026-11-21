import {
  EmptyState,
  ErrorState,
  LoadingState,
  PageHeader,
  StatusChip,
} from "@crvouga/mockingbird-ui/react"
import {
  ArrowDownToLine,
  ArrowLeft,
  ArrowRotateRight,
  Check,
  FileText,
  Magnifier,
  Plus,
  SquareListUl,
} from "@gravity-ui/icons"
import {
  Alert,
  Button,
  Card,
  Description,
  Form,
  Label,
  ListBox,
  SearchField,
  Select,
  Table,
  Tabs,
  TextArea,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
} from "@heroui/react"
import { type FormEvent, useEffect, useState } from "react"
import { can } from "../../app/model.js"
import { api, type Order, type User } from "../api.js"
import { OrdersTable, orderTitle, orderTotal, outOfRange } from "../components/OrdersTable.js"
import {
  date,
  message,
  OrderStatus,
  price,
  Stat,
  statusLabel,
  usePortalContainer,
  useResource,
} from "../components/States.js"
import { navigate } from "../router.js"

const isActive = (order: Order) => !["results_ready", "cancelled"].includes(order.status)
const STEPS = ["pending_payment", "fulfilled", "shipped", "processing", "results_ready"]
const FILES = [
  ["results", "Results spreadsheet", "CSV · Every biomarker, value, range, and flag"],
  ["receipt", "Payment receipt", "TXT · Itemized tests and order total"],
  ["record", "Complete order record", "JSON · Results, review, and timeline"],
] as const

/** Where an order is, from payment to results: done steps checked, the current one marked. */
const Progress = ({ order }: { order: Order }) => {
  const current = STEPS.indexOf(order.status)
  return (
    <ol
      aria-label="Order progress"
      data-testid="order-progress"
      className="grid grid-cols-5 gap-2 text-xs sm:text-sm"
    >
      {STEPS.map((step, index) => (
        <li
          key={step}
          aria-current={index === current ? "step" : undefined}
          className={`flex flex-col gap-2 border-t-2 pt-2 ${index <= current ? "border-accent text-foreground" : "border-border text-muted"}`}
        >
          <span
            className={`inline-flex size-6 items-center justify-center rounded-full text-xs font-semibold ${index < current ? "bg-accent text-accent-foreground" : index === current ? "border-2 border-accent text-accent" : "bg-default text-muted"}`}
          >
            {index < current ? <Check className="size-3.5" /> : index + 1}
          </span>
          {step === "pending_payment" && current > 0 ? "Payment confirmed" : statusLabel(step)}
        </li>
      ))}
    </ol>
  )
}

const OrderDetail = ({
  order,
  user,
  onBack,
  onRefresh,
  onCheckout,
}: {
  order: Order
  user: User
  onBack: () => void
  onRefresh: () => Promise<void>
  onCheckout: (id: string) => void
}) => {
  const [tab, setTab] = useState("report")
  const [download, setDownload] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)
  const [note, setNote] = useState("")
  const [reviewing, setReviewing] = useState(false)
  const file = async (kind: "results" | "receipt" | "record") => {
    setDownload(kind)
    setError(null)
    setSuccess(null)
    try {
      const blob = await api.file(order.id, kind)
      const url = URL.createObjectURL(blob)
      const link = document.createElement("a")
      link.href = url
      link.download = `lab-${order.id}-${kind}.${kind === "results" ? "csv" : kind === "record" ? "json" : "txt"}`
      document.body.append(link)
      link.click()
      link.remove()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
      setSuccess("Your file is ready. Check your downloads.")
    } catch (error) {
      setError(message(error))
    } finally {
      setDownload(null)
    }
  }
  const review = async (event: FormEvent) => {
    event.preventDefault()
    setReviewing(true)
    setError(null)
    setSuccess(null)
    try {
      await api.review(order.id, note)
      setNote("")
      setSuccess("Review saved and added to the order timeline.")
      await onRefresh()
    } catch (error) {
      setError(message(error))
    } finally {
      setReviewing(false)
    }
  }
  const available = {
    results: order.status === "results_ready",
    receipt: order.status !== "pending_payment",
    record: true,
  }
  return (
    <div data-testid="order-detail">
      <div className="mb-4">
        <Button size="sm" variant="ghost" onPress={onBack}>
          <ArrowLeft className="size-4" />
          Back to {order.status === "results_ready" ? "reports" : "orders"}
        </Button>
      </div>
      <PageHeader
        eyebrow={`Order ${order.id.slice(0, 8)}`}
        title={orderTitle(order)}
        description={`${order.patientName} · Ordered ${date(order.createdAt)}`}
        actions={<OrderStatus status={order.status} />}
      />
      <div className="flex flex-col gap-4">
        {error ? <ErrorState error={error} /> : null}
        {success ? (
          <Alert status="success" role="status" data-testid="order-success">
            <Alert.Indicator />
            <Alert.Content>
              <Alert.Description>{success}</Alert.Description>
            </Alert.Content>
          </Alert>
        ) : null}
        <Progress order={order} />
        <Tabs selectedKey={tab} onSelectionChange={(key) => setTab(String(key))}>
          <Tabs.ListContainer>
            <Tabs.List aria-label="Order detail">
              <Tabs.Tab id="report">Results &amp; review</Tabs.Tab>
              <Tabs.Tab id="timeline">Timeline ({order.timeline.length})</Tabs.Tab>
              <Tabs.Tab id="files">Files &amp; receipt</Tabs.Tab>
            </Tabs.List>
          </Tabs.ListContainer>
          <Tabs.Panel id="report" className="flex flex-col gap-4 pt-4">
            {order.status !== "results_ready" ? (
              <Card>
                <EmptyState
                  icon={<FileText />}
                  title={
                    order.status === "pending_payment"
                      ? "Complete payment to start your order"
                      : "Your report is in progress"
                  }
                  description={
                    order.status === "pending_payment"
                      ? "Your selected tests are saved. Resume checkout whenever you’re ready."
                      : "We’ll update this page when the laboratory releases your results."
                  }
                  action={
                    order.status === "pending_payment" && order.userId === user.id ? (
                      <Button onPress={() => onCheckout(order.checkoutSessionId)}>
                        Resume checkout · {price(orderTotal(order))}
                      </Button>
                    ) : undefined
                  }
                />
              </Card>
            ) : (
              <>
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                  <Stat
                    label="Biomarkers measured"
                    value={order.results.reduce((count, panel) => count + panel.markers.length, 0)}
                  />
                  <Stat label="Outside reference range" value={outOfRange(order)} />
                  <Stat
                    label="Clinical review"
                    value={order.reviewedAt ? "Reviewed" : "Awaiting review"}
                  />
                </div>
                <p className="text-sm text-muted">
                  Fictional values and reference ranges for demonstration. The prior sample is
                  synthetic. These results are not for clinical use.
                </p>
                {order.results.map((panel) => (
                  <Card key={panel.panel} className="min-w-0">
                    <Card.Header className="flex-row items-center justify-between gap-2">
                      <Card.Title>{panel.panel}</Card.Title>
                      <span className="text-sm text-muted">{panel.markers.length} biomarkers</span>
                    </Card.Header>
                    <Card.Content>
                      <Table>
                        <Table.ScrollContainer>
                          <Table.Content
                            aria-label={`${panel.panel} results`}
                            data-testid="results-table"
                          >
                            <Table.Header>
                              <Table.Column isRowHeader>Biomarker</Table.Column>
                              <Table.Column>Result</Table.Column>
                              <Table.Column>Reference range</Table.Column>
                              <Table.Column>Prior sample</Table.Column>
                              <Table.Column>Status</Table.Column>
                            </Table.Header>
                            <Table.Body>
                              {panel.markers.map((marker) => (
                                <Table.Row key={marker.name} id={marker.name}>
                                  <Table.Cell className="whitespace-nowrap font-medium">
                                    {marker.name}
                                  </Table.Cell>
                                  <Table.Cell className="whitespace-nowrap">
                                    <span className="font-semibold tabular-nums">
                                      {marker.value}
                                    </span>{" "}
                                    <span className="text-muted">{marker.unit}</span>
                                  </Table.Cell>
                                  <Table.Cell className="min-w-32">
                                    <span className="tabular-nums">
                                      {marker.low}–{marker.high}
                                    </span>
                                    <span
                                      aria-hidden="true"
                                      className="relative mt-1.5 block h-1 rounded-full bg-default"
                                    >
                                      <span
                                        className={`absolute top-1/2 size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full ${marker.flag !== "normal" ? "bg-warning" : "bg-accent"}`}
                                        style={{
                                          left: `${Math.max(2, Math.min(98, 10 + ((marker.value - marker.low) / (marker.high - marker.low)) * 80))}%`,
                                        }}
                                      />
                                    </span>
                                  </Table.Cell>
                                  <Table.Cell className="whitespace-nowrap tabular-nums">
                                    {marker.previous}{" "}
                                    <span className="text-muted">
                                      {marker.value === marker.previous
                                        ? "—"
                                        : marker.value > marker.previous
                                          ? "↑"
                                          : "↓"}
                                    </span>
                                  </Table.Cell>
                                  <Table.Cell>
                                    <StatusChip
                                      status={marker.flag === "normal" ? "ok" : "warning"}
                                    >
                                      {marker.flag === "normal"
                                        ? "In range"
                                        : marker.flag === "low"
                                          ? "Low ↓"
                                          : "High ↑"}
                                    </StatusChip>
                                  </Table.Cell>
                                </Table.Row>
                              ))}
                            </Table.Body>
                          </Table.Content>
                        </Table.ScrollContainer>
                      </Table>
                    </Card.Content>
                  </Card>
                ))}
                <Card data-testid="clinical-review">
                  <Card.Header>
                    <Card.Title>Clinical review</Card.Title>
                  </Card.Header>
                  <Card.Content className="gap-3">
                    {order.reviewedAt ? (
                      <>
                        <Alert status="success">
                          <Alert.Indicator />
                          <Alert.Content>
                            <Alert.Description>
                              Reviewed by {order.reviewer} · {date(order.reviewedAt)}
                            </Alert.Description>
                          </Alert.Content>
                        </Alert>
                        <p className="whitespace-pre-wrap text-sm text-foreground">
                          {order.reviewNote}
                        </p>
                      </>
                    ) : can(user.role, "results.review") ? (
                      <Form className="flex flex-col gap-3" onSubmit={review}>
                        <TextField
                          isRequired
                          minLength={5}
                          maxLength={2000}
                          value={note}
                          onChange={setNote}
                        >
                          <Label>Review note</Label>
                          <TextArea
                            rows={4}
                            placeholder="Record your review and follow-up notes…"
                            data-testid="review-note"
                          />
                          <Description>
                            Saving records your name and timestamp and makes this note visible to
                            the patient.
                          </Description>
                        </TextField>
                        <div>
                          <Button
                            type="submit"
                            data-testid="review-submit"
                            isDisabled={reviewing || note.trim().length < 5}
                          >
                            {reviewing ? "Saving review…" : "Complete review"}
                          </Button>
                        </div>
                      </Form>
                    ) : (
                      <p className="text-sm text-muted">
                        Your care team has not reviewed this report yet. A review note will appear
                        here when available.
                      </p>
                    )}
                  </Card.Content>
                </Card>
              </>
            )}
          </Tabs.Panel>
          <Tabs.Panel id="timeline" className="pt-4">
            <Card>
              <Card.Header>
                <Card.Title>Order activity</Card.Title>
              </Card.Header>
              <Card.Content>
                <ol className="flex flex-col" data-testid="timeline">
                  {order.timeline.map((event) => (
                    <li
                      key={event.id}
                      className="flex gap-3 border-l-2 border-border pb-4 pl-4 last:pb-0"
                    >
                      <div className="flex min-w-0 flex-col gap-1">
                        <div>
                          <OrderStatus status={event.status} />
                        </div>
                        <p className="text-sm text-foreground">{event.detail}</p>
                        <p className="text-xs text-muted">
                          {event.actor} · {new Date(event.createdAt).toLocaleString()}
                        </p>
                      </div>
                    </li>
                  ))}
                </ol>
              </Card.Content>
            </Card>
          </Tabs.Panel>
          <Tabs.Panel id="files" className="flex flex-col gap-4 pt-4">
            <Card>
              <Card.Header>
                <Card.Title>Documents</Card.Title>
                <Card.Description>
                  Export your report, payment receipt, or complete order record.
                </Card.Description>
              </Card.Header>
              <Card.Content className="gap-0 divide-y divide-separator">
                {FILES.map(([kind, title, detail]) => (
                  <div
                    key={kind}
                    className="flex items-center gap-3 py-3 first:pt-0 last:pb-0"
                    data-testid="file-row"
                  >
                    <FileText className="size-5 shrink-0 text-muted" />
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium text-foreground">{title}</p>
                      <p className="text-sm text-muted">
                        {available[kind] ? detail : "Available when this step is complete"}
                      </p>
                    </div>
                    <Button
                      size="sm"
                      variant="secondary"
                      isDisabled={!available[kind] || download !== null}
                      onPress={() => void file(kind)}
                    >
                      <ArrowDownToLine className="size-4" />
                      {download === kind ? "Preparing…" : "Download"}
                    </Button>
                  </div>
                ))}
              </Card.Content>
            </Card>
            <Card>
              <Card.Header>
                <Card.Title>Order summary</Card.Title>
              </Card.Header>
              <Card.Content className="gap-2 text-sm">
                {order.items.map((item) => (
                  <div key={item.testName} className="flex justify-between gap-2">
                    <span>{item.testName}</span>
                    <span className="font-medium">{price(item.priceCents)}</span>
                  </div>
                ))}
                <div className="flex justify-between gap-2 border-t border-separator pt-2 font-semibold">
                  <span>Total</span>
                  <span>{price(orderTotal(order))}</span>
                </div>
                <p className="break-all text-xs text-muted">Order ID: {order.id}</p>
                {order.labOrderId ? (
                  <p className="break-all text-xs text-muted">
                    Laboratory reference: {order.labOrderId}
                  </p>
                ) : null}
              </Card.Content>
            </Card>
          </Tabs.Panel>
        </Tabs>
      </div>
    </div>
  )
}

const STATUS_FILTERS = [
  ["all", "All statuses", true],
  ["active", "In progress", false],
  ["pending_payment", "Awaiting payment", false],
  ["results_ready", "Results ready", false],
  ["unreviewed", "Awaiting review", true],
] as const

/** A labeled HeroUI select over a few fixed options. */
const Choice = ({
  label,
  value,
  options,
  onChange,
  testId,
}: {
  label: string
  value: string
  options: readonly (readonly [string, string])[]
  onChange: (value: string) => void
  testId: string
}) => {
  const portal = usePortalContainer()
  return (
    <Select
      className="w-full sm:w-44"
      selectedKey={value}
      onSelectionChange={(key) => {
        if (key !== null) onChange(String(key))
      }}
    >
      <Label>{label}</Label>
      <Select.Trigger data-testid={testId}>
        <Select.Value />
        <Select.Indicator />
      </Select.Trigger>
      <Select.Popover {...portal}>
        <ListBox>
          {options.map(([id, text]) => (
            <ListBox.Item key={id} id={id} textValue={text}>
              {text}
              <ListBox.ItemIndicator />
            </ListBox.Item>
          ))}
        </ListBox>
      </Select.Popover>
    </Select>
  )
}

export const Orders = ({
  user,
  resultsOnly = false,
  onCheckout,
}: {
  user: User
  resultsOnly?: boolean
  onCheckout: (id: string) => void
}) => {
  const [workspace, setWorkspace] = useState(can(user.role, "orders.read"))
  const [query, setQuery] = useState("")
  const [filter, setFilter] = useState("all")
  const [sort, setSort] = useState("newest")
  const [selected, setSelected] = useState<string | null>(null)
  const resource = useResource(() => api.orders(workspace), String(workspace))
  useEffect(() => {
    const interval = setInterval(() => {
      if (resource.data?.orders.some(isActive) && !resource.busy) void resource.refresh()
    }, 2000)
    return () => clearInterval(interval)
  }, [resource.data, resource.busy, resource.refresh])
  const orders = resource.data?.orders ?? []
  const order = orders.find((order) => order.id === selected)
  const filtered = query || filter !== "all"
  const visible = orders
    .filter(
      (order) =>
        (!resultsOnly || order.status === "results_ready") &&
        (filter === "all" ||
          (filter === "active"
            ? isActive(order)
            : filter === "unreviewed"
              ? order.status === "results_ready" && !order.reviewedAt
              : order.status === filter)) &&
        `${order.patientName} ${order.id} ${orderTitle(order)}`
          .toLowerCase()
          .includes(query.toLowerCase()),
    )
    .sort((a, b) =>
      sort === "oldest"
        ? Date.parse(a.createdAt) - Date.parse(b.createdAt)
        : Date.parse(b.createdAt) - Date.parse(a.createdAt),
    )
  if (order)
    return (
      <OrderDetail
        key={order.id}
        order={order}
        user={user}
        onBack={() => setSelected(null)}
        onRefresh={resource.refresh}
        onCheckout={onCheckout}
      />
    )
  return (
    <div>
      <PageHeader
        eyebrow={workspace ? "Care workspace" : "Personal workspace"}
        title={resultsOnly ? "Results" : "Orders"}
        description={
          resultsOnly
            ? "Explore your reports, compare measurements, and download your records."
            : "Track every order from checkout to clinical review."
        }
        actions={
          <Button onPress={() => navigate("shop")}>
            <Plus className="size-4" />
            Order tests
          </Button>
        }
      />
      <div className="flex flex-col gap-4">
        {can(user.role, "orders.read") ? (
          <ToggleButtonGroup
            aria-label="Order scope"
            size="sm"
            selectionMode="single"
            disallowEmptySelection
            selectedKeys={[workspace ? "all" : "mine"]}
            onSelectionChange={(keys) => {
              const [next] = [...keys]
              setWorkspace(next === "all")
              setSelected(null)
            }}
          >
            <ToggleButton id="mine">My orders</ToggleButton>
            <ToggleButton id="all">All patients</ToggleButton>
          </ToggleButtonGroup>
        ) : null}
        <div className="flex flex-wrap items-end gap-3">
          <SearchField value={query} onChange={setQuery} className="w-full sm:w-auto sm:flex-1">
            <Label>Search</Label>
            <SearchField.Group>
              <SearchField.SearchIcon>
                <Magnifier />
              </SearchField.SearchIcon>
              <SearchField.Input
                placeholder="Search tests, patients, or order ID…"
                data-testid="orders-search"
              />
              <SearchField.ClearButton />
            </SearchField.Group>
          </SearchField>
          <Choice
            label="Status"
            value={filter}
            onChange={setFilter}
            testId="orders-status"
            options={STATUS_FILTERS.filter(([, , always]) => always || !resultsOnly).map(
              ([id, text]) => [id, text] as const,
            )}
          />
          <Choice
            label="Sort"
            value={sort}
            onChange={setSort}
            testId="orders-sort"
            options={[
              ["newest", "Newest first"],
              ["oldest", "Oldest first"],
            ]}
          />
          <Button
            variant="secondary"
            isDisabled={resource.busy}
            onPress={() => void resource.refresh()}
          >
            <ArrowRotateRight className="size-4" />
            {resource.busy ? "Refreshing…" : "Refresh"}
          </Button>
        </div>
        {resource.error ? (
          <ErrorState
            error={resource.error}
            onRetry={() => void resource.refresh()}
            retryLabel="Try again"
          />
        ) : null}
        {!resource.data && resource.busy ? (
          <LoadingState label="Loading orders…" />
        ) : !resource.error && visible.length === 0 ? (
          <Card data-testid="orders-empty">
            <EmptyState
              icon={filtered ? <Magnifier /> : <SquareListUl />}
              title={
                filtered
                  ? "No matching orders"
                  : resultsOnly
                    ? "No reports available yet"
                    : "No orders yet"
              }
              description={
                filtered
                  ? "Try another search or clear your filters."
                  : "Choose a test from the catalog to start your first order."
              }
              action={
                <Button
                  variant={filtered ? "secondary" : "primary"}
                  onPress={() => {
                    if (filtered) {
                      setQuery("")
                      setFilter("all")
                    } else navigate("shop")
                  }}
                >
                  {filtered ? "Clear filters" : "Browse tests"}
                </Button>
              }
            />
          </Card>
        ) : (
          <>
            <p className="text-sm text-muted">
              {visible.length} {resultsOnly ? "reports" : "orders"}
              {orders.some(isActive) ? " · Active orders update automatically" : ""}
            </p>
            <OrdersTable
              label={resultsOnly ? "Reports" : "Orders"}
              orders={visible}
              showPatient={workspace}
              onOpen={(order) => setSelected(order.id)}
            />
          </>
        )}
      </div>
    </div>
  )
}
