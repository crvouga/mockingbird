import {
  ArrowRotateRight,
  ArrowUpRight,
  CircleInfo,
  Grip,
  PlugConnection,
  ShieldCheck,
} from "@gravity-ui/icons"
import {
  Alert,
  Button,
  buttonVariants,
  Card,
  Link,
  Skeleton,
  Switch,
  ToggleButton,
  ToggleButtonGroup,
} from "@heroui/react"
import {
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react"
import { AppShell } from "./react/app-shell.js"
import { PageHeader } from "./react/page-header.js"
import { EmptyState, ErrorState } from "./react/states.js"
import { type Status, StatusChip } from "./react/status-chip.js"
import { ThemeSwitch } from "./react/theme-switch.js"
import { PreviewCard } from "./system-build.js"
import type { SystemBuild } from "./system-build-status.js"
import { IconMark } from "./system-mark.js"
import { move, summarizeServices } from "./system-rotation.js"
import type {
  SystemApp,
  SystemDevStatus,
  SystemService,
  SystemServiceMode,
  SystemServices,
} from "./system-types.js"

/** What the harness hands the System screen. */
export type SystemScreenProps = {
  /** Every surface, System included, in the order the switcher's arrows go through them. */
  apps: readonly SystemApp[]
  excluded: ReadonlySet<string>
  open(id: string): void
  setInRotation(id: string, included: boolean): void
  /** The person reordered the list. */
  setOrder(ids: readonly string[]): void
  services?: SystemServices | undefined
  docsUrl?: string | undefined
  /** The live preview's build status; its Preview card sits above the apps. */
  build?: SystemBuild | undefined
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

const reducedMotion = (node: Element) =>
  node.ownerDocument.defaultView?.matchMedia("(prefers-reduced-motion: reduce)").matches ?? true

/** The System screen: the preview's build, its apps and the switcher's order, and its services. */
export function SystemScreen(props: SystemScreenProps) {
  return (
    <AppShell product="System" actions={<ThemeSwitch />}>
      <PageHeader
        eyebrow="Mockingbird preview"
        title="System"
        description="Everything this preview runs, in this browser tab."
        actions={
          props.docsUrl ? (
            <Link href={props.docsUrl} target="_blank" rel="noreferrer" className="text-sm">
              How dev resources work
              <Link.Icon />
            </Link>
          ) : undefined
        }
      />
      <div className="flex flex-col gap-10">
        {props.build ? <PreviewCard build={props.build} /> : null}
        <Apps {...props} />
        {props.services ? (
          <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
            <ServicesArea services={props.services} />
          </div>
        ) : (
          <NoServices />
        )}
      </div>
    </AppShell>
  )
}

function SectionHead({
  id,
  title,
  children,
  actions,
}: {
  id: string
  title: string
  children?: ReactNode
  actions?: ReactNode
}) {
  return (
    <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0 flex-1 basis-72">
        <h2 id={id} className="text-xl font-semibold tracking-tight text-foreground">
          {title}
        </h2>
        {children}
      </div>
      {actions}
    </div>
  )
}

// ---- Apps: which surfaces the arrows stop at, and in what order.

type Drag = {
  id: string
  pointer: number
  from: number
  to: number
  startY: number
  /** Each row's top and height when the drag began, in list order. */
  rows: { top: number; height: number }[]
  gap: number
}

function Apps({ apps, excluded, open, setInRotation, setOrder }: SystemScreenProps) {
  const headingId = useId()
  const hintId = useId()
  const listRef = useRef<HTMLOListElement>(null)
  const rows = useRef(new Map<string, HTMLLIElement>())
  const grips = useRef(new Map<string, HTMLButtonElement>())
  const drag = useRef<Drag | undefined>(undefined)
  /** Where each row was drawn before a reorder, so it can slide to its new place (FLIP). */
  const before = useRef<Map<string, number> | undefined>(undefined)
  const refocus = useRef<string | undefined>(undefined)
  const [dragging, setDragging] = useState<string>()
  const [announcement, setAnnouncement] = useState("")
  const ids = apps.map((app) => app.id)
  const key = ids.join(" ")
  const surfaces = apps.filter((app) => app.id !== "system")
  const included = surfaces.filter((app) => !excluded.has(app.id)).length

  const tops = () =>
    new Map([...rows.current].map(([id, row]) => [id, row.getBoundingClientRect().top] as const))
  const commit = (id: string, next: string[]) => {
    before.current = tops()
    setOrder(next)
    const label = apps.find((app) => app.id === id)?.label ?? id
    setAnnouncement(`${label} moved to position ${next.indexOf(id) + 1} of ${next.length}.`)
  }

  // Slide every row from where it was drawn to where it now is, then put focus back on the grip.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when the order changes.
  useLayoutEffect(() => {
    const from = before.current
    before.current = undefined
    if (from)
      for (const [id, row] of rows.current) {
        const delta = (from.get(id) ?? 0) - row.getBoundingClientRect().top
        row.style.transition = "none"
        row.style.transform = ""
        if (!delta || reducedMotion(row)) continue
        row.style.transform = `translateY(${delta}px)`
        void row.offsetHeight
        row.style.transition = "transform 160ms ease-out"
        row.style.transform = ""
      }
    if (refocus.current) grips.current.get(refocus.current)?.focus()
    refocus.current = undefined
  }, [key])

  const onKey = (id: string) => (event: KeyboardEvent<HTMLButtonElement>) => {
    const from = ids.indexOf(id)
    const to =
      event.key === "ArrowUp"
        ? from - 1
        : event.key === "ArrowDown"
          ? from + 1
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? ids.length - 1
              : undefined
    if (to === undefined) return
    event.preventDefault()
    if (to < 0 || to >= ids.length || to === from) return
    refocus.current = id
    commit(id, move(ids, from, to))
  }

  // Pointer: the row follows the grip and the others make room as it passes them. Only
  // transforms move during the drag; the list reorders on release, so the dragged row's own
  // node never moves (moving it would release the pointer capture and end the drag).
  const onPointerDown = (id: string) => (event: PointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return
    event.preventDefault()
    try {
      event.currentTarget.setPointerCapture(event.pointerId)
    } catch {
      /* A synthetic pointer has nothing to capture; moves still reach the grip. */
    }
    const measured = ids.map((candidate) => {
      const rect = rows.current.get(candidate)?.getBoundingClientRect()
      return { top: rect?.top ?? 0, height: rect?.height ?? 0 }
    })
    const [first, second] = measured
    const from = ids.indexOf(id)
    drag.current = {
      id,
      pointer: event.pointerId,
      from,
      to: from,
      startY: event.clientY,
      rows: measured,
      gap: first && second ? Math.max(0, second.top - first.top - first.height) : 0,
    }
    for (const row of rows.current.values()) row.style.transition = "none"
    setDragging(id)
  }
  const onPointerMove = (event: PointerEvent<HTMLButtonElement>) => {
    const state = drag.current
    if (!state) return
    const self = state.rows[state.from]
    const top = state.rows[0]
    const bottom = state.rows.at(-1)
    if (!self || !top || !bottom) return
    const dy = Math.max(
      top.top - self.top,
      Math.min(bottom.top + bottom.height - self.top - self.height, event.clientY - state.startY),
    )
    const center = self.top + self.height / 2 + dy
    let to = state.from
    state.rows.forEach((row, index) => {
      const middle = row.top + row.height / 2
      if (index > state.from && center > middle) to = Math.max(to, index)
      if (index < state.from && center < middle) to = Math.min(to, index)
    })
    state.to = to
    const shift = self.height + state.gap
    ids.forEach((id, index) => {
      const row = rows.current.get(id)
      if (!row) return
      if (index === state.from) {
        row.style.transform = `translateY(${dy}px)`
        return
      }
      row.style.transition = reducedMotion(row) ? "none" : "transform 160ms ease-out"
      const offset =
        index > state.from && index <= to ? -shift : index < state.from && index >= to ? shift : 0
      row.style.transform = offset ? `translateY(${offset}px)` : ""
    })
  }
  const onDrop = () => {
    const state = drag.current
    if (!state) return
    drag.current = undefined
    setDragging(undefined)
    if (state.to !== state.from) commit(state.id, move(ids, state.from, state.to))
    else {
      before.current = tops()
      for (const row of rows.current.values()) row.style.transform = ""
      // Nothing moved: let the row settle back from where it was let go.
      const row = rows.current.get(state.id)
      const delta = (before.current.get(state.id) ?? 0) - (row?.getBoundingClientRect().top ?? 0)
      before.current = undefined
      if (row && delta && !reducedMotion(row)) {
        row.style.transform = `translateY(${delta}px)`
        void row.offsetHeight
        row.style.transition = "transform 160ms ease-out"
        row.style.transform = ""
      }
    }
  }

  const setRow = useCallback(
    (id: string) => (node: HTMLLIElement | null) => {
      if (node) rows.current.set(id, node)
      else rows.current.delete(id)
    },
    [],
  )
  const setGrip = useCallback(
    (id: string) => (node: HTMLButtonElement | null) => {
      if (node) grips.current.set(id, node)
      else grips.current.delete(id)
    },
    [],
  )

  return (
    <section aria-labelledby={headingId}>
      <SectionHead id={headingId} title="Apps">
        <p className="mt-1 text-sm text-muted">
          {surfaces.length === 0
            ? "This preview has no apps yet."
            : `${surfaces.length} ${surfaces.length === 1 ? "app" : "apps"} · ${included} in the switcher. The arrows go down this list, skipping the ones you switch off. Drag to reorder.`}
        </p>
      </SectionHead>
      {surfaces.length > 0 ? (
        <>
          <p id={hintId} className="sr-only">
            Drag to reorder, or use the arrow keys, Home and End.
          </p>
          <p role="status" className="sr-only" data-testid="system-apps-status">
            {announcement}
          </p>
          <ol
            ref={listRef}
            aria-label="Switcher order"
            className="msh-apps m-0 flex list-none flex-col gap-2 p-0"
          >
            {apps.map((app) => (
              <li
                key={app.id}
                ref={setRow(app.id)}
                data-app={app.id}
                className={`relative ${dragging === app.id ? "z-10" : ""}`}
              >
                <Card
                  className={`flex-row items-center gap-1 p-2 sm:gap-2 ${
                    dragging === app.id ? "shadow-overlay" : ""
                  }`}
                >
                  <button
                    type="button"
                    ref={setGrip(app.id)}
                    aria-label={`Reorder ${app.label}`}
                    aria-describedby={hintId}
                    className={`${buttonVariants({ variant: "ghost", size: "sm", isIconOnly: true })} shrink-0 touch-none text-muted ${
                      dragging === app.id ? "cursor-grabbing" : "cursor-grab"
                    }`}
                    onKeyDown={onKey(app.id)}
                    onPointerDown={onPointerDown(app.id)}
                    onPointerMove={onPointerMove}
                    onPointerUp={onDrop}
                    onPointerCancel={onDrop}
                    onLostPointerCapture={onDrop}
                  >
                    <Grip className="size-4" aria-hidden="true" />
                  </button>
                  <AppToggle
                    app={app}
                    included={app.id === "system" || !excluded.has(app.id)}
                    onChange={(on) => setInRotation(app.id, on)}
                  />
                  <Button
                    size="sm"
                    variant="secondary"
                    aria-label={`Open ${app.label}`}
                    className="shrink-0"
                    onPress={() => open(app.id)}
                  >
                    <span className="max-sm:sr-only">Open</span>
                    <ArrowUpRight className="size-4" aria-hidden="true" />
                  </Button>
                </Card>
              </li>
            ))}
          </ol>
        </>
      ) : null}
    </section>
  )
}

/** The row's body: a switch for whether the arrows stop here; clicking anywhere on it flips it. */
function AppToggle({
  app,
  included,
  onChange,
}: {
  app: SystemApp
  included: boolean
  onChange(on: boolean): void
}) {
  const text = (
    <span className="flex min-w-0 flex-col text-left">
      <span className="truncate font-medium text-foreground">{app.label}</span>
      {app.description ? (
        <span className="text-sm text-muted [overflow-wrap:anywhere]">{app.description}</span>
      ) : null}
    </span>
  )
  if (app.id === "system")
    return (
      <div className="flex min-w-0 flex-1 items-center gap-3 px-1 py-1">
        <span className="max-sm:hidden">
          <IconMark icon={app.icon} label={app.label} />
        </span>
        {text}
        <span className="ml-auto hidden shrink-0 sm:inline-flex">
          <StatusChip status="neutral">Always on</StatusChip>
        </span>
      </div>
    )
  return (
    <Switch
      isSelected={included}
      onChange={onChange}
      aria-label={`${app.label} in switcher`}
      className="min-w-0 flex-1"
    >
      <Switch.Content className="w-full min-w-0 items-center gap-3 rounded-lg px-1 py-1">
        <Switch.Control className="shrink-0">
          <Switch.Thumb />
        </Switch.Control>
        <span className="max-sm:hidden">
          <IconMark icon={app.icon} label={app.label} />
        </span>
        {text}
      </Switch.Content>
    </Switch>
  )
}

// ---- Services: each emulated in this tab, or a real non-production resource via the dev proxy.

function NoServices() {
  const headingId = useId()
  return (
    <section aria-labelledby={headingId}>
      <SectionHead id={headingId} title="Services">
        <ServicesBlurb />
      </SectionHead>
      <Card>
        <EmptyState
          icon={<PlugConnection />}
          title="No services listed"
          description="The host app supplies them. When it passes its services to the harness, each emulator appears here and can switch between running in this tab and a real non-production resource."
        />
      </Card>
    </section>
  )
}

const ServicesBlurb = () => (
  <p className="mt-1 text-sm text-muted">
    Third-party services the apps call. Each runs emulated in this tab, or against a real
    non-production resource through the dev proxy.
  </p>
)

const PROXY: Record<
  SystemDevStatus["state"] | "loading",
  { chip: string; status: Status; hint: string; dot: string }
> = {
  loading: {
    chip: "Checking",
    status: "info",
    hint: "",
    dot: "bg-muted motion-safe:animate-pulse",
  },
  ready: {
    chip: "Ready",
    status: "ok",
    hint: "It runs on this app's own origin and adds the credentials itself.",
    dot: "bg-success",
  },
  unreachable: {
    chip: "Unreachable",
    status: "error",
    hint: "Check that the proxy is running on this app's origin, then refresh.",
    dot: "bg-danger",
  },
  none: {
    chip: "Not set up",
    status: "neutral",
    hint: "Every service is emulated in this tab. Deploy the dev proxy and give its URL to this preview to reach non-production resources.",
    dot: "border-2 border-muted",
  },
}

/** Read-only: the proxy holds the credentials, so there is nothing to enter here. */
function DevProxyCard({ dev }: { dev: SystemDevStatus | undefined }) {
  const headingId = useId()
  const state = dev?.state ?? "loading"
  const look = PROXY[state]
  return (
    <section aria-labelledby={headingId} data-testid="system-dev-proxy" data-state={state}>
      <Card className="gap-3">
        <Card.Header className="flex-row flex-wrap items-center gap-2.5">
          <span aria-hidden="true" className={`size-2.5 rounded-full ${look.dot}`} />
          <h2 id={headingId} className="text-lg font-semibold text-foreground">
            Dev proxy
          </h2>
          <StatusChip status={look.status}>{look.chip}</StatusChip>
        </Card.Header>
        <Card.Content className="gap-3 text-sm">
          <p className="font-medium text-foreground">{dev?.message ?? "Checking the dev proxy…"}</p>
          {look.hint ? <p className="text-muted">{look.hint}</p> : null}
          <div
            hidden={!dev?.endpoint}
            className="flex min-w-0 items-center gap-2 rounded-lg border border-border bg-surface-secondary px-3 py-2"
          >
            <span className="shrink-0 text-xs font-medium tracking-wide text-muted uppercase">
              Proxy
            </span>
            <code title={dev?.endpoint ?? ""} className="min-w-0 truncate font-mono text-xs">
              {dev?.endpoint ?? ""}
            </code>
          </div>
          <p className="flex items-start gap-2 text-muted">
            <ShieldCheck className="mt-0.5 size-4 shrink-0 text-success" aria-hidden="true" />
            <span>
              Only credentials that match the proxy's non-production allow-list are used. They never
              reach this browser.
            </span>
          </p>
        </Card.Content>
      </Card>
    </section>
  )
}

type Row = { service: SystemService; pending: boolean; error?: string | undefined }

const same = (a: string, b: string) =>
  a.trim().replace(/\.$/, "").toLowerCase() === b.trim().replace(/\.$/, "").toLowerCase()

function ServicesArea({ services }: { services: SystemServices }) {
  const headingId = useId()
  const sharedId = useId()
  const [dev, setDev] = useState<SystemDevStatus>()
  const [rows, setRows] = useState<Row[] | undefined>()
  const [loading, setLoading] = useState(true)
  const [failure, setFailure] = useState<string>()
  const sequence = useRef(0)
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  const load = useCallback(async () => {
    const mine = ++sequence.current
    setLoading(true)
    try {
      const result = await services.list()
      if (!alive.current || mine !== sequence.current) return
      setFailure(undefined)
      setDev(result.dev)
      setRows((previous) =>
        result.services.map((service) => {
          const old = previous?.find((row) => row.service.id === service.id)
          if (old?.pending) return old
          return { service, pending: false, error: old?.error }
        }),
      )
    } catch (error) {
      if (!alive.current || mine !== sequence.current) return
      setFailure(message(error))
    } finally {
      if (alive.current && mine === sequence.current) setLoading(false)
    }
  }, [services])
  useEffect(() => {
    void load()
  }, [load])

  const sharedReason = dev && dev.state !== "ready" ? dev.message : undefined
  const choose = async (id: string, mode: SystemServiceMode) => {
    const row = rows?.find((candidate) => candidate.service.id === id)
    if (!row || row.pending || row.service.mode === mode) return
    const previous = row.service
    const patch = (next: Partial<Row>) =>
      setRows((current) =>
        current?.map((candidate) =>
          candidate.service.id === id ? { ...candidate, ...next } : candidate,
        ),
      )
    patch({ service: { ...previous, mode }, pending: true, error: undefined })
    try {
      await services.setMode(id, mode)
      if (!alive.current) return
      patch({ pending: false })
    } catch (error) {
      if (!alive.current) return
      patch({
        service: previous,
        pending: false,
        error: `Couldn't switch ${previous.label} to ${mode}: ${message(error)}`,
      })
    }
  }

  const summary =
    rows === undefined
      ? failure
        ? "Services could not be listed."
        : "Loading services…"
      : summarizeServices(rows.map((row) => row.service))

  return (
    <>
      <DevProxyCard dev={dev} />
      <section aria-labelledby={headingId} className="min-w-0">
        <SectionHead
          id={headingId}
          title="Services"
          actions={
            <Button
              size="sm"
              variant="ghost"
              isDisabled={loading}
              onPress={() => {
                void load()
              }}
            >
              <ArrowRotateRight
                aria-hidden="true"
                className={`size-4 ${loading ? "motion-safe:animate-spin" : ""}`}
              />
              Refresh
            </Button>
          }
        >
          <ServicesBlurb />
          <p
            className="mt-1 text-sm font-medium text-foreground"
            data-testid="system-services-summary"
          >
            {summary}
          </p>
        </SectionHead>
        <div className="flex flex-col gap-3">
          {failure ? (
            <ErrorState title="Couldn't load services" error={failure} onRetry={load} />
          ) : null}
          <p
            id={sharedId}
            hidden={sharedReason === undefined}
            className="flex items-start gap-2 text-sm text-muted"
          >
            <CircleInfo className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            <span>
              Dev is unavailable for every service: {(sharedReason ?? "").replace(/\.$/, "")}.
            </span>
          </p>
          {rows === undefined && failure ? null : (
            <Card className="p-0">
              <ul
                aria-label="Services"
                aria-busy={rows === undefined}
                className="m-0 list-none divide-y divide-separator p-0"
              >
                {rows === undefined ? (
                  [0, 1, 2, 3].map((index) => (
                    <li
                      key={index}
                      aria-hidden="true"
                      className="flex items-center gap-4 px-4 py-3"
                    >
                      <span className="flex flex-1 flex-col gap-2">
                        <Skeleton className="h-4 w-2/5 rounded-md" />
                        <Skeleton className="h-3 w-1/4 rounded-md" />
                      </span>
                      <Skeleton className="h-8 w-36 rounded-lg" />
                    </li>
                  ))
                ) : rows.length === 0 ? (
                  <li className="px-4 py-3 text-sm text-muted">
                    This preview has no third-party services.
                  </li>
                ) : (
                  rows.map((row) => (
                    <ServiceRow
                      key={row.service.id}
                      row={row}
                      sharedId={sharedId}
                      sharedReason={sharedReason}
                      choose={(mode) => choose(row.service.id, mode)}
                    />
                  ))
                )}
              </ul>
            </Card>
          )}
        </div>
      </section>
    </>
  )
}

function ServiceRow({
  row,
  sharedId,
  sharedReason,
  choose,
}: {
  row: Row
  sharedId: string
  sharedReason: string | undefined
  choose(mode: SystemServiceMode): Promise<void>
}) {
  const { service, pending, error } = row
  const noteId = useId()
  const buttons = useRef(new Map<SystemServiceMode, HTMLButtonElement>())
  const refocus = useRef(false)
  const unavailable = service.unavailable
  const sharedNote =
    sharedReason !== undefined && unavailable !== undefined && same(unavailable, sharedReason)

  // Disabling the half that was pressed drops focus; keep it on the checked one.
  useLayoutEffect(() => {
    if (!refocus.current) return
    const button = buttons.current.get(service.mode)
    if (button && !button.disabled) button.focus()
    if (!pending) refocus.current = false
  }, [service.mode, pending])

  const flip = (focus: boolean, mode: SystemServiceMode) => {
    const active = buttons.current.get("emulated")?.ownerDocument.activeElement
    refocus.current = focus || [...buttons.current.values()].some((button) => button === active)
    void choose(mode)
  }
  const other = service.mode === "dev" ? "emulated" : "dev"
  const blocked = (mode: SystemServiceMode) =>
    mode === "dev" && unavailable !== undefined && service.mode !== "dev"
  const onKeyDownCapture = (event: KeyboardEvent<HTMLDivElement>) => {
    const forward = event.key === "ArrowRight" || event.key === "ArrowDown"
    const backward = event.key === "ArrowLeft" || event.key === "ArrowUp"
    if (!forward && !backward) return
    event.preventDefault()
    event.stopPropagation()
    if (pending || blocked(other)) return
    flip(true, other)
  }

  return (
    <li
      data-service={service.id}
      data-mode={service.mode}
      data-pending={pending ? "" : undefined}
      className="flex flex-col gap-2 px-4 py-3"
    >
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div className="flex min-w-0 flex-1 basis-48 flex-col">
          <span className="flex flex-wrap items-center gap-2">
            <span className="font-medium text-foreground">{service.label}</span>
            <span
              aria-hidden={service.mode !== "dev"}
              className={service.mode === "dev" ? "inline-flex" : "invisible inline-flex"}
            >
              <StatusChip status="warning">Dev resource</StatusChip>
            </span>
          </span>
          <span className="text-sm text-muted">{service.category ?? "Service"}</span>
        </div>
        <div onKeyDownCapture={onKeyDownCapture} className="max-sm:w-full">
          <ToggleButtonGroup
            aria-label={`${service.label} mode`}
            selectionMode="single"
            disallowEmptySelection
            selectedKeys={[service.mode]}
            size="sm"
            className="max-sm:w-full"
          >
            {(["emulated", "dev"] as const).map((mode) => {
              const checked = service.mode === mode
              return (
                <ToggleButton
                  key={mode}
                  id={mode}
                  ref={(node: HTMLButtonElement | null) => {
                    if (node) buttons.current.set(mode, node)
                    else buttons.current.delete(mode)
                  }}
                  isDisabled={blocked(mode) || (pending && !checked)}
                  className="max-sm:flex-1"
                  {...(blocked(mode) ? { "aria-describedby": sharedNote ? sharedId : noteId } : {})}
                  // A toggle: pressing either half flips the mode.
                  onPress={() => flip(false, other)}
                >
                  {mode === "emulated" ? "Emulated" : "Dev"}
                </ToggleButton>
              )
            })}
          </ToggleButtonGroup>
        </div>
      </div>
      <p
        id={noteId}
        hidden={unavailable === undefined || sharedNote}
        className="flex items-start gap-2 text-sm text-muted"
      >
        <CircleInfo className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
        <span>{unavailable ?? ""}</span>
      </p>
      <p role="status" className="sr-only">
        {pending
          ? `Switching to ${service.mode === "dev" ? "the dev resource" : "the emulator"}…`
          : ""}
      </p>
      {error ? (
        <Alert status="danger" role="alert">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Description>{error}</Alert.Description>
          </Alert.Content>
        </Alert>
      ) : null}
    </li>
  )
}
