/**
 * The dashboard: the shared Mockingbird shell (`AppShell`) with HeroUI tabs over the emulators'
 * admin UI, the notifications UI and an embedder's own tabs. The harness page is this, and so is
 * `mountDashboard`. The tab logic lives in `dashboard-model.ts`.
 */
import { AppShell, ErrorState, LoadingState, ThemeSwitch } from "@crvouga/mockingbird-ui/react"
import { Chip, Tabs } from "@heroui/react"
import { type ReactNode, useSyncExternalStore } from "react"
import { TEST_IDS } from "../testids.js"
import { NotificationsApp } from "./app.js"
import { type DashboardEntry, type DashboardModel, NOTIFICATIONS_TAB } from "./dashboard-model.js"
import type { Store } from "./store.js"

export const DASHBOARD_ROOT_CLASS = "mb-dashboard"

function Badge({ count }: { count: number }) {
  return (
    <span
      data-testid={TEST_IDS.dashboardBadge}
      data-count={count}
      hidden={count === 0}
      className="ml-1.5"
    >
      <Chip size="sm" color="accent" variant="primary">
        {count > 99 ? "99+" : count}
        <span className="sr-only"> new</span>
      </Chip>
    </span>
  )
}

function Panel({ model, entry }: { model: DashboardModel; entry: DashboardEntry }) {
  return (
    <>
      {entry.status?.kind === "loading" ? <LoadingState /> : null}
      {entry.status?.kind === "error" ? (
        <ErrorState title={`${entry.label} could not load`} error={entry.status.message} />
      ) : null}
      <div ref={(el) => model.attach(entry.id, el)} className="min-w-0" />
    </>
  )
}

export type DashboardProps = {
  model: DashboardModel
  /** The notifications UI's store, when the dashboard has a Notifications tab. */
  store?: Store
  /** The product name in the top bar. */
  title: string
  /** Called with the top bar's empty slot for an embedder's own status or links. */
  asideRef?: (el: HTMLElement | null) => void
  /** More of the top bar's actions, before the theme switch. */
  actions?: ReactNode
}

export function Dashboard({ model, store, title, asideRef, actions }: DashboardProps) {
  useSyncExternalStore(model.subscribe, model.getVersion, model.getVersion)
  const active = model.active()
  return (
    <div data-testid={TEST_IDS.dashboard} data-tab={active} className="min-h-full">
      <AppShell
        product={title}
        fluid
        actions={
          <>
            <div
              ref={asideRef}
              className="flex items-center gap-3 text-sm text-muted empty:hidden"
            />
            {actions}
            <ThemeSwitch />
          </>
        }
      >
        <Tabs
          selectedKey={active}
          onSelectionChange={(key) => model.show(String(key))}
          className="-mt-2"
        >
          <Tabs.ListContainer className="w-fit max-w-full">
            <Tabs.List aria-label={title}>
              {model.entries.map((entry) => (
                <Tabs.Tab
                  key={entry.id}
                  id={entry.id}
                  data-testid={TEST_IDS.dashboardTab}
                  data-tab={entry.id}
                >
                  {entry.label}
                  {entry.id === NOTIFICATIONS_TAB ? <Badge count={model.unread()} /> : null}
                </Tabs.Tab>
              ))}
            </Tabs.List>
          </Tabs.ListContainer>
          {model.entries.map((entry) => (
            <Tabs.Panel
              key={entry.id}
              id={entry.id}
              shouldForceMount
              data-testid={TEST_IDS.dashboardPanel}
              data-tab={entry.id}
              className="-mx-4 w-auto px-0 pt-2 data-[inert=true]:hidden sm:-mx-6"
            >
              {entry.id === NOTIFICATIONS_TAB && store ? (
                <NotificationsApp store={store} />
              ) : (
                <div
                  className="px-4 sm:px-6"
                  aria-busy={entry.status?.kind === "loading" || undefined}
                >
                  <Panel model={model} entry={entry} />
                </div>
              )}
            </Tabs.Panel>
          ))}
        </Tabs>
      </AppShell>
    </div>
  )
}

/** The standalone page with no emulators to administer: the shell around the notifications UI. */
export function NotificationsPage({ store, title }: { store: Store; title: string }) {
  return (
    <AppShell product={title} fluid actions={<ThemeSwitch />}>
      <div className="-mx-4 -my-6 sm:-mx-6">
        <NotificationsApp store={store} />
      </div>
    </AppShell>
  )
}
