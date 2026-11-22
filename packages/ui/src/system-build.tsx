import { ArrowRotateRight, CircleCheck } from "@gravity-ui/icons"
import { Alert, Button, Card, Description, Link, Spinner, Switch } from "@heroui/react"
import {
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react"
import { flushSync } from "react-dom"
import { type Status, StatusChip } from "./react/status-chip.js"
import {
  ago,
  type BuildTone,
  buildStatus,
  nextVersion,
  type SystemBuild,
  type SystemBuildState,
  shortSha,
  tickAfter,
} from "./system-build-status.js"

/**
 * A store's value, redrawn synchronously on every change, as the DOM it replaced was: a host or a
 * test that changes the store can read the page right after.
 */
export function useStore<T>(subscribe: (listener: () => void) => () => void, get: () => T): T {
  const [value, setValue] = useState(() => get())
  const read = useRef(get)
  read.current = get
  useLayoutEffect(() => {
    const sync = () => {
      const next = read.current()
      flushSync(() => setValue(() => next))
    }
    setValue(() => read.current())
    return subscribe(sync)
  }, [subscribe])
  return value
}

/** The build's current state, redrawn on every change. */
export function useBuildState(build: SystemBuild): SystemBuildState {
  const subscribe = useCallback(
    (listener: () => void) => {
      const stop = build.subscribe(listener)
      return () => void stop()
    },
    [build],
  )
  return useStore(subscribe, () => build.get())
}

/** The status dot's fill for each tone, from the theme's status colors. */
export const TONE_FILL: Record<BuildTone, string> = {
  ok: "bg-success",
  building: "bg-warning",
  ready: "bg-accent",
  failed: "bg-danger",
  offline: "bg-muted",
}

/** What each tone means, as a StatusChip status. */
export const TONE_STATUS: Record<BuildTone, Status> = {
  ok: "ok",
  building: "warning",
  ready: "info",
  failed: "error",
  offline: "neutral",
}

const CHIPS: Record<BuildTone, string> = {
  ok: "Up to date",
  building: "Building",
  ready: "Update ready",
  failed: "Needs attention",
  offline: "Offline",
}

const absolute = (iso: string) => {
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString()
}

/**
 * A relative time that repaints on its own: every second while it is under a minute old, then
 * every 15 s. Only its text changes; the `<time>` element and everything around it stay.
 */
export function RelativeTime({
  iso,
  format = (relative) => relative,
}: {
  iso: string
  format?: (relative: string) => string
}) {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    const timer = setTimeout(() => setNow(Date.now()), tickAfter(iso, now))
    return () => clearTimeout(timer)
  }, [iso, now])
  return (
    <time dateTime={iso} title={absolute(iso)} className="tabular-nums">
      {format(ago(iso, now))}
    </time>
  )
}

/** A commit SHA, short, with the full one as its title. */
export function Sha({ version }: { version: string }) {
  return (
    <code
      title={version}
      className="rounded-md border border-border bg-surface-secondary px-1.5 font-mono text-xs leading-5 text-foreground"
    >
      {shortSha(version)}
    </code>
  )
}

function External({ href, label, name }: { href: string; label: string; name?: string }) {
  return (
    <Link
      href={href}
      target="_blank"
      rel="noreferrer"
      className="text-sm font-medium"
      {...(name ? { "aria-label": name } : {})}
    >
      {label}
      <Link.Icon />
    </Link>
  )
}

/** The main line of a row: a chip, a SHA, a sentence. */
const Main = ({ children, className = "" }: { children: ReactNode; className?: string }) => (
  <span
    className={`flex min-h-6 flex-wrap items-center gap-x-1.5 gap-y-1 font-medium ${className}`}
  >
    {children}
  </span>
)

/** The line under it: facts separated by dots, a link apart. */
function Sub({ parts }: { parts: (ReactNode | undefined)[] }) {
  const shown = parts.filter((part) => part !== undefined && part !== null && part !== false)
  return (
    <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-sm text-muted">
      {shown.map((part, index) => (
        // The parts are fixed per row; their position is their identity.
        // biome-ignore lint/suspicious/noArrayIndexKey: positional, never reordered.
        <span key={index} className="inline-flex items-center gap-2 whitespace-nowrap">
          {index > 0 ? <span aria-hidden="true">·</span> : null}
          {part}
        </span>
      ))}
    </span>
  )
}

const None = ({ children }: { children: ReactNode }) => (
  <Main className="font-normal text-muted">{children}</Main>
)

function StateChip({ tone, label }: { tone: "ok" | "busy" | "failed"; label: string }) {
  return (
    <StatusChip status={tone === "busy" ? "warning" : tone === "failed" ? "error" : "ok"}>
      <span className="inline-flex items-center gap-1">
        {tone === "busy" ? (
          <span data-busy="" className="inline-flex">
            <Spinner size="sm" color="current" className="size-3" />
          </span>
        ) : null}
        {label}
      </span>
    </StatusChip>
  )
}

const ROWS = [
  ["tab", "This tab"],
  ["latest", "Latest deployed"],
  ["build", "Build"],
  ["checks", "Checks"],
  ["connection", "Connection"],
] as const

/** Saves the preview's in-tab data as a file (the System screen's `snapshot.save`). */
export type PreviewCardSnapshot = { save(): Promise<Blob> }

const downloadName = (version: string, blob: Blob) =>
  `preview-data-${shortSha(version)}${blob.type.includes("json") ? ".json" : ""}`

/** Hands `blob` to the browser as a download named `name`. */
function download(blob: Blob, name: string, doc: Document) {
  const url = URL.createObjectURL(blob)
  const link = doc.createElement("a")
  link.href = url
  link.download = name
  link.hidden = true
  doc.body.append(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

type SaveState = { state: "idle" | "saving" | "saved" } | { state: "failed"; message: string }

/**
 * Said before an update that resets the preview's data: it waits for the person, and Save (when
 * the screen has a snapshot) downloads the data first.
 */
function ResetsDataNotice({
  version,
  running,
  snapshot,
}: {
  version: string
  running: string
  snapshot?: PreviewCardSnapshot | undefined
}) {
  const [save, setSave] = useState<SaveState>({ state: "idle" })
  const root = useRef<HTMLDivElement>(null)
  const onSave = async () => {
    if (!snapshot) return
    setSave({ state: "saving" })
    try {
      const blob = await snapshot.save()
      download(blob, downloadName(running, blob), root.current?.ownerDocument ?? document)
      setSave({ state: "saved" })
    } catch (error) {
      setSave({ state: "failed", message: error instanceof Error ? error.message : String(error) })
    }
  }
  return (
    <div ref={root} data-testid="system-preview-resets-data">
      <Alert status="warning">
        <Alert.Indicator />
        <Alert.Content>
          <Alert.Title>New version {shortSha(version)} resets this preview's data</Alert.Title>
          <Alert.Description>
            It won't update on its own.{" "}
            {snapshot
              ? "Save the data first if you want to keep it, then update."
              : "Update when you're ready to start over."}
            {save.state === "saved" ? " Saved." : null}
            {save.state === "failed" ? ` Couldn't save: ${save.message}` : null}
          </Alert.Description>
        </Alert.Content>
        {snapshot ? (
          <Button
            size="sm"
            variant="secondary"
            className="self-center"
            isDisabled={save.state === "saving"}
            onPress={() => void onSave()}
          >
            {save.state === "saving" ? "Saving…" : save.state === "saved" ? "Save again" : "Save"}
          </Button>
        ) : null}
      </Alert>
    </div>
  )
}

/** The System screen's Preview card: this tab's version, the latest deploy, build, checks and connection. */
export function PreviewCard({
  build,
  snapshot,
}: {
  build: SystemBuild
  /** Offers Save before an update that resets the preview's data. */
  snapshot?: PreviewCardSnapshot | undefined
}) {
  const state = useBuildState(build)
  const headingId = useId()
  const hintId = useId()
  const status = buildStatus(state, Date.now())
  const next = nextVersion(state)
  const { current, latest, build: event, checks, update } = state
  const failedUpdate = update.available && update.error !== undefined
  const resetsData =
    update.available && update.resetsData === true && !update.applying && !failedUpdate
  const chip = update.applying
    ? "Updating"
    : failedUpdate
      ? "Update failed"
      : status.tone === "failed"
        ? "Build failed"
        : CHIPS[status.tone]
  const pulse =
    (status.tone === "ok" && state.connection === "live") || status.tone === "building"
      ? "motion-safe:animate-pulse"
      : ""

  const values: Record<(typeof ROWS)[number][0], ReactNode> = {
    tab: (
      <>
        <Main>
          <Sha version={current.version} />
        </Main>
        <Sub
          parts={[<RelativeTime key="t" iso={current.builtAt} format={(r) => `built ${r}`} />]}
        />
      </>
    ),
    latest: !latest ? (
      <None>None reported yet</None>
    ) : (
      <>
        {next ? (
          <Main>
            <Sha version={latest.version} />
            <StatusChip status="info">New</StatusChip>
          </Main>
        ) : (
          <Main className="flex-nowrap items-start text-success">
            <CircleCheck className="mt-1 size-4 shrink-0" aria-hidden="true" />
            <span>This tab is up to date</span>
          </Main>
        )}
        <Sub parts={[<RelativeTime key="t" iso={latest.at} format={(r) => `deployed ${r}`} />]} />
      </>
    ),
    build: !event ? (
      <None>No build reported yet</None>
    ) : (
      <>
        <Main>
          <StateChip
            tone={event.state === "building" ? "busy" : event.state === "failed" ? "failed" : "ok"}
            label={{ building: "Building", deployed: "Deployed", failed: "Failed" }[event.state]}
          />
          <Sha version={event.version} />
        </Main>
        <Sub
          parts={[
            <RelativeTime key="t" iso={event.at} />,
            event.url ? (
              <External
                key="l"
                href={event.url}
                label="View run"
                name={`View build run for ${shortSha(event.version)}`}
              />
            ) : undefined,
          ]}
        />
        {event.message ? <span className="text-sm text-danger">{event.message}</span> : null}
      </>
    ),
    checks: !checks ? (
      <None>No checks reported yet</None>
    ) : (
      <>
        <Main>
          <StateChip
            tone={checks.state === "running" ? "busy" : checks.state === "failed" ? "failed" : "ok"}
            label={{ running: "Running", passed: "Passed", failed: "Failed" }[checks.state]}
          />
          {checks.summary ? (
            <span className="text-sm">{checks.summary}</span>
          ) : (
            <Sha version={checks.version} />
          )}
        </Main>
        <Sub
          parts={[
            <RelativeTime key="t" iso={checks.at} />,
            checks.url ? (
              <External
                key="l"
                href={checks.url}
                label="View checks"
                name={`View checks for ${shortSha(checks.version)}`}
              />
            ) : undefined,
          ]}
        />
      </>
    ),
    connection: (
      <>
        <Main>
          <span
            aria-hidden="true"
            className={`size-2 rounded-full ${
              state.connection === "live"
                ? "bg-success motion-safe:animate-pulse"
                : state.connection === "polling"
                  ? "bg-warning"
                  : "border-2 border-muted"
            }`}
          />
          {state.connection === "live"
            ? "Live"
            : state.connection === "polling"
              ? "Polling every 15 s"
              : "Offline"}
        </Main>
        {state.checkedAt ? (
          <Sub
            parts={[
              <RelativeTime
                key="t"
                iso={state.checkedAt}
                format={(r) =>
                  state.connection === "offline" ? `last checked ${r}` : `checked ${r}`
                }
              />,
            ]}
          />
        ) : (
          <span className="text-sm text-muted">
            {state.connection === "live" ? "Updates arrive as they happen" : "Not reached yet"}
          </span>
        )}
      </>
    ),
  }

  return (
    <section
      aria-labelledby={headingId}
      data-testid="system-preview"
      data-resets-data={resetsData ? "true" : undefined}
      data-tone={status.tone}
      data-connection={state.connection}
    >
      <Card className="gap-4">
        <Card.Header className="flex-row flex-wrap items-center gap-x-2.5 gap-y-2">
          <span
            aria-hidden="true"
            className={`size-2.5 rounded-full ${TONE_FILL[status.tone]} ${pulse}`}
          />
          <h2 id={headingId} className="text-lg font-semibold text-foreground">
            Preview
          </h2>
          <span data-testid="system-preview-state">
            <StatusChip status={TONE_STATUS[status.tone]}>{chip}</StatusChip>
          </span>
          {state.pr ? (
            <span className="ml-auto">
              <External href={state.pr.url} label={`PR #${state.pr.number}`} />
            </span>
          ) : null}
        </Card.Header>
        <Card.Content className="gap-4">
          <dl className="m-0 grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-5">
            {ROWS.map(([row, label]) => (
              <div
                key={row}
                data-row={row}
                className="flex min-w-0 flex-col gap-1.5 rounded-lg border border-border bg-surface-secondary px-3 py-2.5"
              >
                <dt className="text-xs font-medium tracking-wide text-muted uppercase">{label}</dt>
                <dd className="m-0 grid min-w-0 gap-1">{values[row]}</dd>
              </div>
            ))}
          </dl>
          {resetsData && next ? (
            // Keyed: a different pending version starts a fresh Save.
            <ResetsDataNotice
              key={next}
              version={next}
              running={current.version}
              snapshot={snapshot}
            />
          ) : null}
          {failedUpdate ? (
            <Alert status="danger" role="alert">
              <Alert.Indicator />
              <Alert.Content>
                <Alert.Description>
                  Couldn't update to {shortSha(next ?? "")}: {update.error}
                </Alert.Description>
              </Alert.Content>
            </Alert>
          ) : null}
        </Card.Content>
        <Card.Footer className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3 border-t border-separator pt-4">
          <Switch
            isSelected={update.auto}
            onChange={(on) => build.setAutoUpdate(on)}
            aria-label="Auto-update"
            aria-describedby={hintId}
          >
            <Switch.Content>
              <Switch.Control>
                <Switch.Thumb />
              </Switch.Control>
              <span className="text-sm font-medium text-foreground">Auto-update</span>
            </Switch.Content>
            <Description id={hintId}>
              New versions apply themselves after a short countdown
            </Description>
          </Switch>
          <Button
            className="max-sm:w-full"
            isDisabled={!update.available || update.applying}
            onPress={() => {
              void build.applyUpdate().catch(() => {
                /* Reported through `update.error`. */
              })
            }}
          >
            <ArrowRotateRight
              aria-hidden="true"
              className={`size-4 ${update.applying ? "motion-safe:animate-spin" : ""}`}
            />
            {update.applying ? "Updating…" : failedUpdate ? "Retry update" : "Update now"}
          </Button>
        </Card.Footer>
      </Card>
    </section>
  )
}
