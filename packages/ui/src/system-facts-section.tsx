/**
 * A facts section (#903): the host passes grouped label / value rows (feature flags, the
 * configuration a build runs with) and the screen draws them, with a filter.
 */
import { Card, SearchField } from "@heroui/react"
import { useEffect, useState } from "react"
import { ErrorState, LoadingState } from "./react/states.js"
import { type Status, StatusChip } from "./react/status-chip.js"
import { countFacts, filterFacts } from "./system-facts.js"
import type { SystemFact, SystemFactGroup, SystemFactsSection } from "./system-types.js"

const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

type State =
  | { status: "loading" }
  | { status: "ready"; groups: readonly SystemFactGroup[] }
  | { status: "error"; error: string }

/** Loads the section once (and again on Retry), then draws its groups. */
export function FactsSection({ section }: { section: SystemFactsSection }) {
  const [state, setState] = useState<State>({ status: "loading" })
  const [attempt, setAttempt] = useState(0)
  // biome-ignore lint/correctness/useExhaustiveDependencies: loaded again only on Retry.
  useEffect(() => {
    let alive = true
    setState({ status: "loading" })
    Promise.resolve()
      .then(() => section.load())
      .then(
        (groups) => {
          if (alive) setState({ status: "ready", groups })
        },
        (error: unknown) => {
          if (alive) setState({ status: "error", error: message(error) })
        },
      )
    return () => {
      alive = false
    }
  }, [section, attempt])
  return (
    <div data-testid={`system-section-${section.id}`} data-state={state.status}>
      {state.status === "error" ? (
        <ErrorState
          title={`Couldn't load ${section.label}`}
          error={state.error}
          onRetry={() => setAttempt((value) => value + 1)}
        />
      ) : state.status === "loading" ? (
        <LoadingState label={`Loading ${section.label}…`} />
      ) : (
        <FactsView label={section.label} groups={state.groups} />
      )}
    </div>
  )
}

/** The loaded rows: a filter, a count, and one card per group. */
export function FactsView({
  label,
  groups,
  initialQuery = "",
}: {
  label: string
  groups: readonly SystemFactGroup[]
  initialQuery?: string
}) {
  const [query, setQuery] = useState(initialQuery)
  const total = countFacts(groups)
  const shown = filterFacts(groups, query)
  const matched = countFacts(shown)
  if (total === 0)
    return (
      <p className="m-0 text-sm text-muted">{`${label} has nothing to show in this preview.`}</p>
    )
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <SearchField
          aria-label={`Filter ${label}`}
          value={query}
          onChange={setQuery}
          className="w-full max-w-sm"
        >
          <SearchField.Group>
            <SearchField.SearchIcon />
            <SearchField.Input placeholder={`Filter ${label.toLowerCase()}`} />
            <SearchField.ClearButton />
          </SearchField.Group>
        </SearchField>
        <p role="status" data-testid="system-facts-count" className="m-0 text-sm text-muted">
          {query.trim()
            ? `${matched} of ${total} ${total === 1 ? "row" : "rows"} match`
            : `${total} ${total === 1 ? "row" : "rows"} in ${groups.length} ${groups.length === 1 ? "group" : "groups"}`}
        </p>
      </div>
      {shown.length === 0 ? (
        <p className="m-0 text-sm text-muted" data-testid="system-facts-empty">
          Nothing matches “{query.trim()}”.
        </p>
      ) : (
        <div className="grid grid-cols-1 items-start gap-3 lg:grid-cols-2">
          {shown.map((group) => (
            <Card key={group.group} className="gap-0 p-0" data-fact-group={group.group}>
              <h3 className="border-b border-separator px-4 py-2.5 text-sm font-semibold text-foreground">
                {group.group}
              </h3>
              <ul aria-label={group.group} className="m-0 list-none divide-y divide-separator p-0">
                {group.rows.map((row) => (
                  <FactRow key={`${row.label}\n${row.value}`} row={row} />
                ))}
              </ul>
            </Card>
          ))}
        </div>
      )}
    </div>
  )
}

const TONE: Record<NonNullable<SystemFact["tone"]>, Status> = {
  on: "ok",
  off: "neutral",
  muted: "neutral",
}

function FactRow({ row }: { row: SystemFact }) {
  return (
    <li
      data-fact={row.label}
      data-tone={row.tone}
      className="flex items-start justify-between gap-3 px-4 py-2.5"
    >
      <span className="flex min-w-0 flex-col">
        <span className="font-mono text-sm text-foreground [overflow-wrap:anywhere]">
          {row.label}
        </span>
        {row.note ? <span className="text-xs text-muted">{row.note}</span> : null}
      </span>
      <span className="shrink-0 text-sm">
        {row.tone === "on" || row.tone === "off" ? (
          <StatusChip status={TONE[row.tone]}>{row.value}</StatusChip>
        ) : (
          <span
            className={`font-mono [overflow-wrap:anywhere] ${row.tone === "muted" ? "text-muted" : "text-foreground"}`}
          >
            {row.value}
          </span>
        )}
      </span>
    </li>
  )
}
