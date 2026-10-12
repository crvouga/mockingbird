import { ReloadOutlined, SearchOutlined } from "@ant-design/icons"
import type { TableProps } from "antd"
import { Alert, Button, Empty, Flex, Input, Table, Tag, Typography } from "antd"
import type { ReactNode } from "react"
import { useCallback, useEffect, useRef, useState } from "react"
import type { Api } from "./model.js"
import { errorMessage, pretty, text } from "./model.js"

const LIVE_REFRESH_MS = 1_500

/** The admin controls guide. Each control has a page of its own under it. */
const GUIDE = "https://mockingbird.chrisvouga.dev/docs/admin-controls"

/** A view's heading, with a link to the page of the guide that defines what the view controls. */
export function ViewTitle({ page, children }: { page?: string; children: ReactNode }) {
  return (
    <Flex align="baseline" gap="middle">
      <Typography.Title level={3} style={{ margin: 0 }}>
        {children}
      </Typography.Title>
      <Typography.Link
        href={page === undefined ? GUIDE : `${GUIDE}/${page}`}
        target="_blank"
        rel="noopener noreferrer"
      >
        Docs
      </Typography.Link>
    </Flex>
  )
}

/**
 * Admin reads stay live while their view is mounted. Polling is deliberately
 * quiet: it preserves the last successful payload and only shows the spinner
 * for the initial/manual load, so changing emulator state never flashes the UI.
 */
export function useResource<T>(api: Api, path: string, revision = 0, live = true) {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [retry, setRetry] = useState(0)
  // biome-ignore lint/correctness/useExhaustiveDependencies: revision and retry intentionally invalidate the request.
  useEffect(() => {
    const controller = new AbortController()
    let current = true
    let pending = false
    const load = async (foreground: boolean) => {
      if (pending) return
      pending = true
      if (foreground) setLoading(true)
      try {
        const value = await api.get<T>(path, controller.signal)
        if (current) {
          setData(value)
          setError(null)
        }
      } catch (error) {
        if (current && !controller.signal.aborted) setError(errorMessage(error))
      } finally {
        pending = false
        if (current && foreground) setLoading(false)
      }
    }
    void load(true)
    const refresh = () => void load(false)
    const interval = live ? window.setInterval(refresh, LIVE_REFRESH_MS) : undefined
    if (live) window.addEventListener("focus", refresh)
    return () => {
      current = false
      controller.abort()
      if (interval !== undefined) window.clearInterval(interval)
      if (live) window.removeEventListener("focus", refresh)
    }
  }, [api, path, revision, retry, live])
  return { data, error, loading, reload: useCallback(() => setRetry((n) => n + 1), []) }
}

export const ErrorNotice = ({ error, retry }: { error: string | null; retry?: () => void }) =>
  error ? (
    <Alert
      type="error"
      title="Request failed"
      description={error}
      showIcon
      action={retry && <Button onClick={retry}>Try again</Button>}
    />
  ) : null

export const Json = ({ value }: { value: unknown }) => (
  <Input.TextArea
    aria-label="JSON data"
    readOnly
    value={pretty(value)}
    autoSize={{ minRows: 3, maxRows: 18 }}
  />
)

type Row = { key: string; index: number; value: Record<string, unknown> }
type GridProps = {
  rows: Record<string, unknown>[]
  columns?: readonly string[]
  rowKeys?: readonly string[]
  /** Column widths in pixels, by name. Default: 200. */
  widths?: Readonly<Record<string, number>>
  loading?: boolean
  total?: number
  page?: number
  pageSize?: number
  onPage?: (page: number, size: number) => void
  pagination?: false
  action?: (row: Record<string, unknown>, index: number) => ReactNode
  actionWidth?: number
  /** What an expanded row shows. Default: the row itself. */
  detail?: (row: Record<string, unknown>, index: number) => unknown
}

/** Structured data uses Ant Design's sizing, sorting, expansion, and pagination. */
export function DataTable({
  rows,
  columns,
  rowKeys,
  widths,
  loading = false,
  total,
  page,
  pageSize = 25,
  onPage,
  pagination,
  action,
  actionWidth = 100,
  detail,
}: GridProps) {
  const [search, setSearch] = useState("")
  const names = columns ?? [...new Set(rows.flatMap((row) => Object.keys(row)))]
  const data = rows.map((value, index) => ({
    key: rowKeys?.[index] ?? String(index),
    index,
    value,
  }))
  const query = search.toLocaleLowerCase()
  const filtered = data.filter(
    (row) => !query || text(row.value).toLocaleLowerCase().includes(query),
  )
  const tableColumns: TableProps<Row>["columns"] = names.map((name) => ({
    key: name,
    title: name,
    width: widths?.[name] ?? 200,
    ellipsis: { showTitle: true },
    sorter: (a, b) =>
      text(a.value[name]).localeCompare(text(b.value[name]), undefined, { numeric: true }),
    render: (_, row) =>
      row.value[name] === null ? (
        <Typography.Text type="secondary">NULL</Typography.Text>
      ) : typeof row.value[name] === "boolean" ? (
        <Tag>{String(row.value[name])}</Tag>
      ) : (
        text(row.value[name])
      ),
  }))
  if (action)
    tableColumns.push({
      key: "actions",
      title: "Actions",
      fixed: "right",
      width: actionWidth,
      render: (_, row) => action(row.value, row.index),
    })
  return (
    <Flex vertical gap="middle" style={{ minWidth: 0 }}>
      <Input
        prefix={<SearchOutlined />}
        aria-label="Search loaded rows"
        placeholder="Search loaded rows"
        value={search}
        onChange={(event) => setSearch(event.target.value)}
        allowClear
        style={{ maxWidth: 360 }}
      />
      <Table<Row>
        size="small"
        bordered
        rowKey="key"
        columns={tableColumns}
        dataSource={filtered}
        loading={loading}
        tableLayout="fixed"
        scroll={{
          x: Math.max(
            600,
            names.reduce((sum, name) => sum + (widths?.[name] ?? 200), action ? actionWidth : 0),
          ),
        }}
        pagination={
          pagination === false
            ? false
            : onPage
              ? {
                  current: page ?? 1,
                  pageSize,
                  total: total ?? rows.length,
                  showSizeChanger: true,
                  pageSizeOptions: [25, 50, 100, 200],
                  onChange: onPage,
                  showTotal: (count) => `${count} records`,
                }
              : { pageSize, showSizeChanger: true, showTotal: (count) => `${count} loaded records` }
        }
        locale={{
          emptyText: (
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description={query ? "No matching rows on this page" : "No records"}
            />
          ),
        }}
        expandable={{
          expandedRowRender: (row) => (
            <Json value={detail ? detail(row.value, row.index) : row.value} />
          ),
        }}
      />
    </Flex>
  )
}

export function useAction(api: Api, onDone?: () => void) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])
  const run = async (method: string, path: string, body?: unknown): Promise<boolean> => {
    setBusy(true)
    setError(null)
    try {
      await api.send(method, path, body)
      if (alive.current) onDone?.()
      return true
    } catch (error) {
      if (alive.current) setError(errorMessage(error))
      return false
    } finally {
      if (alive.current) setBusy(false)
    }
  }
  return { busy, error, run }
}

export const Refresh = ({ loading, onClick }: { loading: boolean; onClick: () => void }) => (
  <Button icon={<ReloadOutlined />} loading={loading} onClick={onClick}>
    Refresh
  </Button>
)
