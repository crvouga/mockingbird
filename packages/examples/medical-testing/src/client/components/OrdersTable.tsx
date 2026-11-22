import { Table } from "@heroui/react"
import type { Order } from "../api.js"
import { date, OrderStatus, price } from "./States.js"

export const orderTotal = (order: Order): number =>
  order.items.reduce((sum, item) => sum + item.priceCents, 0)
export const outOfRange = (order: Order): number =>
  order.results.flatMap((panel) => panel.markers).filter((marker) => marker.flag !== "normal")
    .length
export const orderTitle = (order: Order): string =>
  order.items.map((item) => item.testName).join(" + ")

/** Orders as rows: press one to open it. The Overview shows a few, Orders and Results all. */
export const OrdersTable = ({
  orders,
  label,
  showPatient,
  compact = false,
  onOpen,
}: {
  orders: Order[]
  label: string
  showPatient: boolean
  /** The Overview's short form: tests, date and status only. */
  compact?: boolean
  onOpen: (order: Order) => void
}) => (
  <Table>
    <Table.ScrollContainer>
      <Table.Content
        aria-label={label}
        onRowAction={(key) => {
          const order = orders.find((candidate) => candidate.id === key)
          if (order) onOpen(order)
        }}
      >
        <Table.Header>
          <Table.Column isRowHeader>Tests</Table.Column>
          <Table.Column>Ordered</Table.Column>
          {showPatient ? <Table.Column>Patient</Table.Column> : null}
          <Table.Column>Status</Table.Column>
          {compact ? null : <Table.Column>Report</Table.Column>}
          {compact ? null : <Table.Column className="text-end">Total</Table.Column>}
        </Table.Header>
        <Table.Body>
          {orders.map((order) => (
            <Table.Row
              key={order.id}
              id={order.id}
              className="cursor-pointer"
              data-testid="order-row"
              data-order-id={order.id}
            >
              <Table.Cell className="min-w-48 font-medium">{orderTitle(order)}</Table.Cell>
              <Table.Cell className="whitespace-nowrap text-muted">
                {date(order.createdAt)}
                <span className="block font-mono text-xs">#{order.id.slice(0, 8)}</span>
              </Table.Cell>
              {showPatient ? (
                <Table.Cell className="whitespace-nowrap">{order.patientName}</Table.Cell>
              ) : null}
              <Table.Cell>
                <OrderStatus status={order.status} />
              </Table.Cell>
              {compact ? null : (
                <Table.Cell className="whitespace-nowrap text-muted">
                  {order.status === "results_ready"
                    ? `${outOfRange(order)} outside range · ${order.reviewedAt ? "Reviewed" : "Awaiting review"}`
                    : "In progress"}
                </Table.Cell>
              )}
              {compact ? null : (
                <Table.Cell className="whitespace-nowrap text-end font-medium">
                  {price(orderTotal(order))}
                </Table.Cell>
              )}
            </Table.Row>
          ))}
        </Table.Body>
      </Table.Content>
    </Table.ScrollContainer>
  </Table>
)
