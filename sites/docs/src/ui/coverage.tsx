import { Check } from "@gravity-ui/icons"
import { Card, Meter, type SortDescriptor, Table } from "@heroui/react"
import { type ReactNode, useEffect, useMemo, useState } from "react"
import { Monogram } from "./primitives.tsx"

export type CoverageRow = {
  name: string
  displayName: string
  logo: string | null
  parity: string
  category: string
  kind: "http" | "sql" | "node"
  opsSupported: number
  opsTotal: number
  inProcess: boolean
  server: boolean
  cli: boolean
}

const COLUMNS = [
  { id: "name", label: "Service", numeric: false },
  { id: "parity", label: "Parity", numeric: false },
  { id: "category", label: "Category", numeric: false },
  { id: "coverage", label: "Operations", numeric: true },
  { id: "inprocess", label: "In-process", numeric: true },
  { id: "server", label: "Server", numeric: true },
  { id: "cli", label: "CLI", numeric: true },
] as const
type Key = (typeof COLUMNS)[number]["id"]
const isKey = (value: unknown): value is Key => COLUMNS.some((c) => c.id === value)

const sortValue = (row: CoverageRow, key: Key): number | string => {
  switch (key) {
    case "name":
      return row.displayName.toLowerCase()
    case "parity":
      return row.parity.toLowerCase()
    case "category":
      return row.category
    case "coverage":
      // Ties on the share go to the service with more operations; no contract sorts last.
      return row.opsTotal ? row.opsSupported / row.opsTotal + row.opsSupported / 1e6 : -1
    case "inprocess":
      return Number(row.inProcess)
    case "server":
      return Number(row.server)
    case "cli":
      return Number(row.cli)
  }
}

function Mark({ on }: { on: boolean }) {
  return on ? (
    <Check className="mx-auto size-4 text-success" role="img" aria-label="Yes" />
  ) : (
    <span className="block text-center text-muted">
      <span aria-hidden="true">–</span>
      <span className="sr-only">No</span>
    </span>
  )
}

/**
 * Every service's coverage in a HeroUI Table, sortable by any column. The sort lives in
 * `?sort=<key>&dir=asc|desc`, so a sorted view is shareable.
 */
export function CoverageTable({ rows }: { rows: CoverageRow[] }) {
  const [sort, setSort] = useState<SortDescriptor | undefined>(undefined)

  useEffect(() => {
    const params = new URLSearchParams(location.search)
    const key = params.get("sort")
    if (isKey(key))
      setSort({
        column: key,
        direction: params.get("dir") === "desc" ? "descending" : "ascending",
      })
  }, [])

  const sorted = useMemo(() => {
    if (!sort || !isKey(sort.column)) return rows
    const key = sort.column
    const factor = sort.direction === "descending" ? -1 : 1
    return [...rows].sort((a, b) => {
      const x = sortValue(a, key)
      const y = sortValue(b, key)
      const cmp =
        typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y))
      return cmp * factor || a.displayName.localeCompare(b.displayName)
    })
  }, [rows, sort])

  return (
    <Table>
      <Table.ScrollContainer>
        <Table.Content
          aria-label="Coverage by service"
          {...(sort ? { sortDescriptor: sort } : {})}
          onSortChange={(next) => {
            // A number column sorts most first on its first click.
            const column = COLUMNS.find((c) => c.id === next.column)
            const fresh = sort?.column !== next.column
            const descriptor: SortDescriptor =
              fresh && column?.numeric ? { column: next.column, direction: "descending" } : next
            setSort(descriptor)
            const url = new URL(location.href)
            url.searchParams.set("sort", String(descriptor.column))
            url.searchParams.set("dir", descriptor.direction === "descending" ? "desc" : "asc")
            history.replaceState(null, "", url)
          }}
        >
          <Table.Header>
            {COLUMNS.map((column) => (
              <Table.Column
                key={column.id}
                id={column.id}
                allowsSorting
                isRowHeader={column.id === "name"}
                className={`whitespace-nowrap ${column.numeric && column.id !== "coverage" ? "text-center" : ""}`}
              >
                {({ sortDirection }) => (
                  <Table.SortableColumnHeader sortDirection={sortDirection}>
                    {column.label}
                  </Table.SortableColumnHeader>
                )}
              </Table.Column>
            ))}
          </Table.Header>
          <Table.Body>
            {sorted.map((row) => (
              <Table.Row key={row.name} id={row.name}>
                <Table.Cell>
                  <a
                    href={`/services/${row.name}`}
                    className="inline-flex items-center gap-2.5 font-semibold whitespace-nowrap text-foreground no-underline hover:text-accent"
                  >
                    <Monogram name={row.displayName} logo={row.logo} size="sm" />
                    {row.displayName}
                  </a>
                </Table.Cell>
                <Table.Cell>{row.parity}</Table.Cell>
                <Table.Cell className="whitespace-nowrap text-muted">{row.category}</Table.Cell>
                <Table.Cell>
                  {row.opsTotal > 0 ? (
                    <Meter
                      aria-label={`${row.displayName}: ${row.opsSupported} of ${row.opsTotal} operations`}
                      value={row.opsSupported}
                      maxValue={row.opsTotal}
                      size="sm"
                      className="flex min-w-40 flex-row items-center gap-3"
                    >
                      <Meter.Track className="flex-1">
                        <Meter.Fill />
                      </Meter.Track>
                      <span className="min-w-14 text-right text-xs text-muted tabular-nums">
                        {row.opsSupported}/{row.opsTotal}
                      </span>
                    </Meter>
                  ) : (
                    <span className="text-muted">
                      {row.kind === "sql" ? "SQL engine" : "Full server"}
                    </span>
                  )}
                </Table.Cell>
                <Table.Cell>
                  <Mark on={row.inProcess} />
                </Table.Cell>
                <Table.Cell>
                  <Mark on={row.server} />
                </Table.Cell>
                <Table.Cell>
                  <Mark on={row.cli} />
                </Table.Cell>
              </Table.Row>
            ))}
          </Table.Body>
        </Table.Content>
      </Table.ScrollContainer>
    </Table>
  )
}

const Code = ({ children }: { children: ReactNode }) => (
  <code className="rounded bg-default px-1 py-0.5 font-mono text-[0.85em]">{children}</code>
)

/** What each column means. */
export function CoverageLegend() {
  const items = [
    ["Parity", "The vendor surface this emulator keeps in step, declared by the package."],
    [
      "Operations",
      "Emulated operations out of every operation in the package's vendored OpenAPI contract.",
    ],
    [
      "In-process",
      <>
        Exports <Code>createRuntime()</Code>: a <Code>fetch(Request) → Response</Code> for tests.
      </>,
    ],
    [
      "Server",
      <>
        Ships <Code>{"<package>/server"}</Code>, a Node HTTP server for a local origin.
      </>,
    ],
    [
      "CLI",
      <>
        Ships a <Code>{"mockingbird-<name> serve"}</Code> binary.
      </>,
    ],
  ] as const
  return (
    <Card className="mt-6">
      <Card.Content>
        <dl className="m-0 grid grid-cols-[repeat(auto-fill,minmax(min(100%,15rem),1fr))] gap-4 text-sm">
          {items.map(([term, detail]) => (
            <div key={term}>
              <dt className="font-semibold text-foreground">{term}</dt>
              <dd className="m-0 mt-0.5 text-muted">{detail}</dd>
            </div>
          ))}
        </dl>
      </Card.Content>
    </Card>
  )
}
