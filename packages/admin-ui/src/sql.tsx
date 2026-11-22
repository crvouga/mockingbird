import { KeyValueList, StatusChip } from "@crvouga/mockingbird-ui/react"
import { Play } from "@gravity-ui/icons"
import { Button, Chip, Form } from "@heroui/react"
import { useEffect, useRef, useState } from "react"
import {
  DataTable,
  ErrorNotice,
  Refresh,
  SearchSelect,
  Section,
  TextInput,
  useChrome,
  useResource,
  ViewTitle,
} from "./components.js"
import type { Api, SqlResult, SqlTable } from "./model.js"
import { errorMessage } from "./model.js"

export function SqlExplorer({ api, revision }: { api: Api; revision: number }) {
  const tables = useResource<{ tables: SqlTable[] }>(api, "/sql/tables", revision)
  const [selected, setSelected] = useState("")
  const current =
    tables.data?.tables.find((table) => `${table.schema}.${table.name}` === selected) ??
    tables.data?.tables[0]
  const [sql, setSql] = useState("")
  const [result, setResult] = useState<SqlResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const alive = useRef(true)
  const { notify } = useChrome()
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])
  const run = async () => {
    if (!sql.trim() || busy) return
    setBusy(true)
    setError(null)
    setResult(null)
    try {
      const response = await api.send<SqlResult>("POST", "/sql/query", { sql })
      if (!alive.current) return
      setResult(response)
      tables.reload()
      notify(
        `${response.rowCount ?? response.rows.length} rows${response.truncated ? " (truncated)" : ""}`,
      )
    } catch (error) {
      if (alive.current) setError(errorMessage(error))
    } finally {
      if (alive.current) setBusy(false)
    }
  }
  return (
    <div className="flex min-w-0 flex-col gap-6">
      <ViewTitle
        docs={false}
        description="The live database: browse its tables, or run a statement against it."
        actions={<Refresh loading={tables.loading} onClick={tables.reload} />}
      >
        SQL
      </ViewTitle>
      <ErrorNotice error={tables.error} retry={tables.reload} />
      <Section title="Tables">
        <SearchSelect
          label="Table"
          ariaLabel="Database table"
          placeholder="Choose a table"
          value={current ? `${current.schema}.${current.name}` : null}
          onChange={setSelected}
          choices={
            tables.data?.tables.map((table) => ({
              label: `${table.schema}.${table.name}`,
              value: `${table.schema}.${table.name}`,
            })) ?? []
          }
          className="w-full max-w-md"
        />
        {current && (
          <TableBrowser
            key={`${current.schema}.${current.name}`}
            api={api}
            table={current}
            revision={revision}
          />
        )}
      </Section>
      <Section title="Query runner">
        <Form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault()
            void run()
          }}
        >
          <TextInput
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                event.preventDefault()
                void run()
              }
            }}
            label="SQL statement"
            ariaLabel="SQL statement"
            rows={5}
            monospace
            value={sql}
            onChange={setSql}
            placeholder="SELECT * FROM …"
            description="Run a statement against the live database. Command/Ctrl + Enter also runs it."
          />
          <Button type="submit" className="self-start" isPending={busy} isDisabled={!sql.trim()}>
            <Play className="size-4" />
            Run query
          </Button>
        </Form>
        <ErrorNotice error={error} />
        {result && (
          <>
            <div>
              <StatusChip status="info">
                {result.rowCount ?? result.rows.length} rows
                {result.truncated ? " · truncated" : ""}
              </StatusChip>
            </div>
            <DataTable label="Query result" rows={result.rows} columns={result.columns} />
          </>
        )}
      </Section>
    </div>
  )
}

function TableBrowser({ api, table, revision }: { api: Api; table: SqlTable; revision: number }) {
  const [page, setPage] = useState(1)
  const [size, setSize] = useState(25)
  const data = useResource<SqlResult>(
    api,
    `/sql/tables/${encodeURIComponent(table.schema)}/${encodeURIComponent(table.name)}?limit=${size}&offset=${(page - 1) * size}`,
    revision,
  )
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <ErrorNotice error={data.error} retry={data.reload} />
      <DataTable
        label={`${table.schema}.${table.name}`}
        rows={data.data?.rows ?? []}
        columns={table.columns.map((column) => column.name)}
        loading={data.loading}
        total={data.data?.total ?? 0}
        page={page}
        pageSize={size}
        onPage={(next, nextSize) => {
          setPage(nextSize === size ? next : 1)
          setSize(nextSize)
        }}
      />
      <div>
        <h4 className="mb-2 text-sm font-semibold text-foreground">Schema</h4>
        <KeyValueList
          items={table.columns.map((column) => ({
            id: column.name,
            label: <span className="font-mono text-[13px]">{column.name}</span>,
            value: (
              <span className="inline-flex flex-wrap items-center gap-2">
                <span className="font-mono text-[13px]">{column.type}</span>
                {column.primaryKey && <Chip size="sm">Primary key</Chip>}
              </span>
            ),
          }))}
        />
      </div>
    </div>
  )
}
