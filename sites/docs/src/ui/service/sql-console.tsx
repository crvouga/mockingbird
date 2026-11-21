import { ErrorState, StatusChip } from "@crvouga/mockingbird-ui/react"
import { Button, Card, Kbd, Spinner, Table } from "@heroui/react"
import { useEffect, useRef, useState } from "react"
import { highlightSql } from "../../client/render.ts"
import { type Snippet, splitStatements } from "../../lib/sql.ts"
import { Icon } from "../icon.tsx"
import { modEnterLabel, runtimeLoader, warm } from "./runtime.ts"

interface Database {
  query(sql: string): Record<string, unknown>[]
  changes: number
  close(): void
}

type Status = { state: "idle" | "loading" | "ready" | "error"; text: string }

type Block = {
  sql: string
  ms?: string
  rows?: Record<string, unknown>[]
  changes?: number
  error?: { code?: string; message: string }
}

type Output = { kind: "note"; text: string } | { kind: "error"; text: string } | Block[]

const shown = (sql: string) => (sql.length > 120 ? `${sql.slice(0, 117)}…` : sql)

const cell = (v: unknown) =>
  v === null || v === undefined ? (
    <span className="text-muted">NULL</span>
  ) : typeof v === "object" ? (
    JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x))
  ) : (
    String(v)
  )

/** The same field look as HeroUI's TextArea, under which the highlighted copy is painted. */
const EDITOR =
  "m-0 min-h-56 w-full p-3 font-mono text-[13px] leading-relaxed whitespace-pre-wrap break-words [tab-size:2]"

/**
 * A SQL console on the real engine (the postgres or sqlite emulator) running in this tab: the
 * build-checked snippets, an editor with highlighting, and one result per statement.
 */
export function SqlConsole({
  service,
  packageName,
  snippets,
}: {
  service: string
  packageName: string
  snippets: Snippet[]
}) {
  const [modEnter, setModEnter] = useState("⌘↵")
  useEffect(() => setModEnter(modEnterLabel()), [])
  const [status, setStatus] = useState<Status>({
    state: "idle",
    text: `Loads the real ${packageName} engine into this tab on first run`,
  })
  const [sql, setSql] = useState(snippets[0]?.sql ?? "")
  const [output, setOutput] = useState<Output>({
    kind: "note",
    text: "Run a statement to see results.",
  })
  const [running, setRunning] = useState(false)
  const input = useRef<HTMLTextAreaElement>(null)
  const paint = useRef<HTMLPreElement>(null)
  // biome-ignore lint/suspicious/noExplicitAny: the engine module's shape.
  const mod = useRef<Promise<any> | undefined>(undefined)
  const db = useRef<Database | undefined>(undefined)

  const engine = async (): Promise<Database> => {
    mod.current ??= (async () => {
      const load = await runtimeLoader(service)
      if (!load) throw new Error(`No browser build for ${service}`)
      setStatus({ state: "loading", text: "Loading the engine…" })
      const t0 = performance.now()
      const m = await load()
      setStatus({
        state: "ready",
        text: `Running in this tab · loaded in ${Math.round(performance.now() - t0)} ms · pure TypeScript, no server`,
      })
      return m
    })().catch((error: Error) => {
      mod.current = undefined
      setStatus({ state: "error", text: `Could not load the engine: ${error.message}` })
      throw error
    })
    const m = await mod.current
    db.current ??= new m.Database() as Database
    return db.current
  }

  const run = async () => {
    const statements = splitStatements(sql)
    if (statements.length === 0) return
    setRunning(true)
    try {
      let d: Database
      try {
        d = await engine()
      } catch (error) {
        setOutput({ kind: "error", text: (error as Error).message })
        return
      }
      const blocks: Block[] = []
      for (const statement of statements) {
        const t0 = performance.now()
        try {
          const rows = d.query(statement)
          const ms = (performance.now() - t0).toFixed(2)
          blocks.push(
            rows.length > 0
              ? { sql: statement, ms, rows }
              : { sql: statement, ms, changes: d.changes },
          )
        } catch (error) {
          const e = error as Error & { code?: string }
          blocks.push({
            sql: statement,
            error: { message: e.message, ...(e.code ? { code: e.code } : {}) },
          })
          break
        }
      }
      setOutput(blocks)
    } finally {
      setRunning(false)
    }
  }

  const sync = () => {
    if (!paint.current || !input.current) return
    paint.current.scrollTop = input.current.scrollTop
    paint.current.scrollLeft = input.current.scrollLeft
  }

  return (
    <Card
      className="gap-0 overflow-hidden p-0"
      data-sql
      data-service={service}
      data-state={status.state}
      onPointerEnter={() => warm(service)}
      onFocus={() => warm(service)}
    >
      <div className="flex flex-wrap items-center gap-2 border-b border-separator bg-surface-secondary px-3 py-2">
        <span className="flex min-w-0 items-center gap-2 text-sm text-muted" role="status">
          {status.state === "loading" ? (
            <Spinner size="sm" />
          ) : (
            <StatusChip
              status={
                status.state === "ready" ? "ok" : status.state === "error" ? "error" : "neutral"
              }
              dot
            >
              {status.state === "ready" ? "Live" : status.state === "error" ? "Error" : "Idle"}
            </StatusChip>
          )}
          <span className="min-w-0">{status.text}</span>
        </span>
        <Button
          variant="ghost"
          size="sm"
          className="ml-auto"
          isDisabled={status.state !== "ready"}
          onPress={() => {
            db.current?.close()
            db.current = undefined
            setOutput({
              kind: "note",
              text: "Fresh database. Start with snippet 1 to create the tables.",
            })
          }}
        >
          <Icon name="reset" /> New database
        </Button>
      </div>
      <div className="flex flex-col gap-3 p-3">
        <div className="flex flex-wrap gap-1.5">
          {snippets.map((snippet, i) => (
            <Button
              key={snippet.label}
              size="sm"
              variant="secondary"
              data-snippet={i}
              onPress={() => {
                setSql(snippet.sql)
                input.current?.focus()
              }}
            >
              {i + 1}. {snippet.label}
            </Button>
          ))}
        </div>
        <div className="relative overflow-hidden rounded-lg border border-field-border bg-field focus-within:border-accent">
          <pre
            ref={paint}
            aria-hidden="true"
            className={`${EDITOR} pointer-events-none absolute inset-0 overflow-hidden text-foreground`}
            // A trailing newline keeps the painted copy as tall as the textarea's last line.
            dangerouslySetInnerHTML={{ __html: `${highlightSql(sql)}\n` }}
          />
          <textarea
            ref={input}
            aria-label="SQL"
            spellCheck={false}
            className={`${EDITOR} relative block resize-y overflow-auto border-0 bg-transparent text-transparent caret-foreground outline-none`}
            value={sql}
            onChange={(event) => setSql(event.target.value)}
            onScroll={sync}
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                event.preventDefault()
                void run()
              }
            }}
          />
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <span className="min-w-0 flex-1 text-xs text-muted">
            Statements run in order against one in-memory database. These snippets also run during
            the build.
          </span>
          <Button size="sm" onPress={() => void run()} isPending={running}>
            <Icon name="play" /> Run
            <Kbd className="hidden sm:inline-flex">{modEnter}</Kbd>
          </Button>
        </div>
        <div className="flex min-w-0 flex-col gap-3" aria-live="polite">
          {Array.isArray(output) ? (
            output.map((block, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: one result per statement, in order.
              <div key={i} className="flex min-w-0 flex-col gap-1.5">
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  <code
                    className="min-w-0 flex-1 truncate font-mono text-xs"
                    dangerouslySetInnerHTML={{ __html: highlightSql(shown(block.sql)) }}
                  />
                  {block.error ? null : block.rows ? (
                    <span className="text-xs text-muted">
                      {block.rows.length} row{block.rows.length === 1 ? "" : "s"} · {block.ms} ms
                    </span>
                  ) : (
                    <StatusChip status="ok">
                      OK · {block.changes} row{block.changes === 1 ? "" : "s"} affected · {block.ms}{" "}
                      ms
                    </StatusChip>
                  )}
                </div>
                {block.error ? (
                  <ErrorState title={block.error.code ?? "Error"} error={block.error.message} />
                ) : block.rows ? (
                  <ResultTable rows={block.rows} />
                ) : null}
              </div>
            ))
          ) : output.kind === "error" ? (
            <ErrorState title="Could not run" error={output.text} />
          ) : (
            <p className="text-sm text-muted">{output.text}</p>
          )}
        </div>
      </div>
    </Card>
  )
}

function ResultTable({ rows }: { rows: Record<string, unknown>[] }) {
  const columns = Object.keys(rows[0] ?? {})
  return (
    <Table>
      <Table.ScrollContainer className="max-h-80 overflow-auto">
        <Table.Content aria-label="Result rows">
          <Table.Header>
            {columns.map((c, i) => (
              <Table.Column key={c} id={c} isRowHeader={i === 0} className="font-mono">
                {c}
              </Table.Column>
            ))}
          </Table.Header>
          <Table.Body>
            {rows.slice(0, 200).map((row, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: rows have no key of their own.
              <Table.Row key={i} id={i}>
                {columns.map((c) => (
                  <Table.Cell key={c} className="font-mono text-xs whitespace-nowrap">
                    {cell(row[c])}
                  </Table.Cell>
                ))}
              </Table.Row>
            ))}
          </Table.Body>
        </Table.Content>
      </Table.ScrollContainer>
    </Table>
  )
}
