import { EmptyState, ErrorState, LoadingState, PageHeader } from "@crvouga/mockingbird-ui/react"
import { ArrowRight, Plus, SquareListUl } from "@gravity-ui/icons"
import { Button, Card } from "@heroui/react"
import { can } from "../../app/model.js"
import { api, type User } from "../api.js"
import { OrdersTable } from "../components/OrdersTable.js"
import { Stat, useResource } from "../components/States.js"
import { navigate } from "../router.js"

const HOW = [
  ["01", "Choose your tests", "Select individual tests or combine panels in one order."],
  [
    "02",
    "Complete collection",
    "Your kit request and laboratory processing appear on the timeline.",
  ],
  ["03", "Explore your results", "Review measurements, see care notes, and download your records."],
] as const

export const Dashboard = ({ user }: { user: User }) => {
  const team = can(user.role, "orders.read")
  const { data, error, busy, refresh } = useResource(() => api.orders(team))
  const orders = data?.orders ?? []
  const ready = orders.filter((order) => order.status === "results_ready")
  const active = orders.filter((order) => !["results_ready", "cancelled"].includes(order.status))
  const unreviewed = ready.filter((order) => !order.reviewedAt)
  const showUpdates = user.notifications && unreviewed.length > 0
  return (
    <div>
      <PageHeader
        eyebrow={team ? "Care workspace" : "Personal workspace"}
        title={`Welcome back${user.name ? `, ${user.name.split(" ")[0]}` : ""}.`}
        description={
          team
            ? "Keep track of patient orders and reports awaiting your review."
            : "A clear view of your tests, results, and next steps."
        }
        actions={
          <Button onPress={() => navigate("shop")}>
            <Plus className="size-4" />
            Order tests
          </Button>
        }
      />
      {error ? (
        <ErrorState error={error} onRetry={() => void refresh()} retryLabel="Try again" />
      ) : null}
      {!data ? (
        busy ? (
          <LoadingState label="Loading your workspace…" />
        ) : null
      ) : (
        <div className="flex flex-col gap-6">
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            <Stat label="Total orders" value={orders.length} />
            <Stat label="In progress" value={active.length} />
            <Stat label="Reports available" value={ready.length} />
            <Stat label="Awaiting review" value={unreviewed.length} />
          </div>
          <div className="grid gap-6 lg:grid-cols-[2fr_1fr]">
            <Card className="min-w-0">
              <Card.Header className="flex-row items-center justify-between gap-2">
                <Card.Title>Recent activity</Card.Title>
                <Button size="sm" variant="ghost" onPress={() => navigate("orders")}>
                  View orders
                  <ArrowRight className="size-4" />
                </Button>
              </Card.Header>
              <Card.Content>
                {orders.length ? (
                  <OrdersTable
                    compact
                    label="Recent orders"
                    orders={orders.slice(0, 4)}
                    showPatient={team}
                    onOpen={(order) =>
                      navigate(order.status === "results_ready" ? "results" : "orders")
                    }
                  />
                ) : (
                  <EmptyState
                    icon={<SquareListUl />}
                    title="Your history starts here"
                    description="Once you order a test, you can follow its progress here."
                    action={<Button onPress={() => navigate("shop")}>Find a test</Button>}
                  />
                )}
              </Card.Content>
            </Card>
            <Card>
              <Card.Header>
                <span className="text-sm text-muted">
                  {user.notifications ? "Next steps" : "Quick access"}
                </span>
                <Card.Title>
                  {showUpdates
                    ? team
                      ? "Reports need your review"
                      : "New results are available"
                    : active.length
                      ? "An order is in progress"
                      : "Ready for your next test?"}
                </Card.Title>
                <Card.Description>
                  {showUpdates
                    ? team
                      ? "Open all patient results to review measurements and record your notes."
                      : "See biomarker values, reference ranges, and your care team’s review."
                    : active.length
                      ? "Follow your order timeline. This workspace updates as your order progresses."
                      : "Browse individual tests and panels. Review your total before checkout."}
                </Card.Description>
              </Card.Header>
              <Card.Footer>
                <Button
                  onPress={() =>
                    navigate(showUpdates ? "results" : active.length ? "orders" : "shop")
                  }
                >
                  {showUpdates ? "View results" : active.length ? "Track order" : "Browse catalog"}
                  <ArrowRight className="size-4" />
                </Button>
              </Card.Footer>
            </Card>
          </div>
          <Card>
            <Card.Header>
              <Card.Title>How testing works</Card.Title>
            </Card.Header>
            <Card.Content className="grid gap-4 sm:grid-cols-3">
              {HOW.map(([number, title, detail]) => (
                <div key={number} className="flex flex-col gap-1">
                  <span className="font-mono text-xs text-muted">{number}</span>
                  <h3 className="text-sm font-semibold text-foreground">{title}</h3>
                  <p className="text-sm text-muted">{detail}</p>
                </div>
              ))}
            </Card.Content>
          </Card>
        </div>
      )}
    </div>
  )
}
