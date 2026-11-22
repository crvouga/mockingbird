import { EmptyState, ErrorState, JsonView, PageHeader } from "@crvouga/mockingbird-ui/react"
import { ArrowRotateRight, Eye } from "@gravity-ui/icons"
import {
  Alert,
  AlertDialog,
  Button,
  Card,
  ComboBox,
  Description,
  FieldError,
  Input,
  Label,
  Link,
  ListBox,
  Modal,
  NumberField,
  Pagination,
  SearchField,
  Select,
  type SortDescriptor,
  Spinner,
  Switch,
  Table,
  TextArea,
  TextField,
} from "@heroui/react"
import type { KeyboardEvent, ReactNode } from "react"
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react"
import type { Api } from "./model.js"
import { errorMessage, text } from "./model.js"
import { initialResource, resourceFor, resourceReducer } from "./resource.js"

const LIVE_REFRESH_MS = 1_500

/** The admin controls guide. Each control has a page of its own under it. */
const GUIDE = "https://mockingbird.chrisvouga.dev/docs/admin-controls"

/* -------------------------------------------------------------------------------------------------
 * Chrome: where overlays render, transient notices, and confirmations.
 *
 * HeroUI's overlays (menus, dialogs) portal into `document.body` by default. The admin is often
 * mounted inside a Shadow DOM, where the stylesheet only reaches the shadow root, and inside a
 * host that scopes the theme to its own subtree. So every overlay is portalled into an element
 * inside the mount instead, and notices are drawn there too rather than with a body-level toast.
 * -----------------------------------------------------------------------------------------------*/

export type Confirmation = {
  title: string
  content?: ReactNode
  okText?: string
  danger?: boolean
  /** Runs when confirmed; the dialog closes once it settles. */
  onOk: () => Promise<unknown> | unknown
}

type ChromeValue = {
  portal: HTMLElement | undefined
  notify(message: string): void
  confirm(confirmation: Confirmation): void
}

const ChromeContext = createContext<ChromeValue>({
  portal: undefined,
  notify: () => {},
  confirm: () => {},
})

export const useChrome = (): ChromeValue => useContext(ChromeContext)

/** Spread onto a HeroUI popover or modal backdrop so it renders inside the admin's mount. */
export const usePortal = (): { UNSTABLE_portalContainer?: Element } => {
  const { portal } = useChrome()
  return portal ? { UNSTABLE_portalContainer: portal } : {}
}

const NOTICE_MS = 4_000

export function Chrome({ children }: { children: ReactNode }) {
  const [portal, setPortal] = useState<HTMLElement | null>(null)
  const [notices, setNotices] = useState<{ id: number; message: string }[]>([])
  const [pending, setPending] = useState<Confirmation | null>(null)
  const [busy, setBusy] = useState(false)
  const next = useRef(0)
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>())
  useEffect(() => {
    const active = timers.current
    return () => {
      for (const timer of active) clearTimeout(timer)
    }
  }, [])
  const value = useMemo<ChromeValue>(
    () => ({
      portal: portal ?? undefined,
      notify: (message) => {
        const id = next.current++
        setNotices((list) => [...list.slice(-2), { id, message }])
        const timer = setTimeout(() => {
          timers.current.delete(timer)
          setNotices((list) => list.filter((notice) => notice.id !== id))
        }, NOTICE_MS)
        timers.current.add(timer)
      },
      confirm: (confirmation) => setPending(confirmation),
    }),
    [portal],
  )
  const settle = async () => {
    if (!pending) return
    setBusy(true)
    try {
      await pending.onOk()
    } catch {
      // The view that asked reports the failure beside its own controls.
    } finally {
      setBusy(false)
      setPending(null)
    }
  }
  return (
    <ChromeContext value={value}>
      {children}
      <div
        role="status"
        aria-live="polite"
        className="pointer-events-none fixed right-4 bottom-4 left-4 z-50 flex flex-col items-end gap-2 sm:left-auto"
      >
        {notices.map((notice) => (
          <Alert
            key={notice.id}
            status="success"
            className="pointer-events-auto w-full shadow-lg sm:w-96"
          >
            <Alert.Indicator />
            <Alert.Content>
              <Alert.Title>{notice.message}</Alert.Title>
            </Alert.Content>
          </Alert>
        ))}
      </div>
      <AlertDialog.Backdrop
        isOpen={pending !== null}
        onOpenChange={(open) => {
          if (!open && !busy) setPending(null)
        }}
        {...(portal ? { UNSTABLE_portalContainer: portal } : {})}
      >
        <AlertDialog.Container size="sm">
          <AlertDialog.Dialog>
            <AlertDialog.Header>
              <AlertDialog.Icon status={pending?.danger ? "danger" : "accent"} />
              <AlertDialog.Heading>{pending?.title}</AlertDialog.Heading>
            </AlertDialog.Header>
            {pending?.content ? (
              <AlertDialog.Body>
                <p className="break-words text-sm text-muted">{pending.content}</p>
              </AlertDialog.Body>
            ) : null}
            <AlertDialog.Footer>
              <Button variant="tertiary" isDisabled={busy} onPress={() => setPending(null)}>
                Cancel
              </Button>
              <Button
                variant={pending?.danger ? "danger" : "primary"}
                isPending={busy}
                onPress={() => void settle()}
              >
                {pending?.okText ?? "OK"}
              </Button>
            </AlertDialog.Footer>
          </AlertDialog.Dialog>
        </AlertDialog.Container>
      </AlertDialog.Backdrop>
      <div ref={setPortal} data-mockingbird-admin-portal />
    </ChromeContext>
  )
}

/* -------------------------------------------------------------------------------------------------
 * Screen layout
 * -----------------------------------------------------------------------------------------------*/

/** A screen's title, with a link to the page of the guide that defines what the screen controls. */
export function ViewTitle({
  page,
  children,
  description,
  actions,
  docs = true,
}: {
  page?: string
  children: ReactNode
  description?: ReactNode
  actions?: ReactNode
  docs?: boolean
}) {
  return (
    <PageHeader
      title={children}
      description={description}
      actions={
        docs || actions ? (
          <>
            {docs ? (
              <Link
                href={page === undefined ? GUIDE : `${GUIDE}/${page}`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-sm"
              >
                Docs
                <Link.Icon />
              </Link>
            ) : null}
            {actions}
          </>
        ) : undefined
      }
    />
  )
}

/** A card with a title, an optional description and actions, used for every block of a screen. */
export function Section({
  title,
  description,
  actions,
  children,
  className,
}: {
  title: ReactNode
  description?: ReactNode
  actions?: ReactNode
  children?: ReactNode
  className?: string
}) {
  return (
    <Card className={`min-w-0 ${className ?? ""}`.trim()}>
      <Card.Header className="flex flex-row flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1 basis-60">
          <Card.Title>{title}</Card.Title>
          {description ? <Card.Description>{description}</Card.Description> : null}
        </div>
        {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
      </Card.Header>
      {children ? (
        <Card.Content className="flex min-w-0 flex-col gap-4">{children}</Card.Content>
      ) : null}
    </Card>
  )
}

/* -------------------------------------------------------------------------------------------------
 * Data
 * -----------------------------------------------------------------------------------------------*/

/**
 * Admin reads stay live while their view is mounted. Polling is deliberately
 * quiet: it preserves the last successful payload and only shows the spinner
 * for the initial/manual load, so changing emulator state never flashes the UI.
 * Switching to another api or path starts empty instead of showing the old payload.
 */
export function useResource<T>(api: Api, path: string, revision = 0, live = true) {
  // A payload belongs to the api and path that fetched it. Switching either drops it,
  // so a failed request for a new emulator never shows the previous emulator's data.
  const source = useMemo(() => ({ api, path }), [api, path])
  const [state, dispatch] = useReducer(resourceReducer<T>, source, (initial: unknown) =>
    initialResource<T>(initial),
  )
  const [retry, setRetry] = useState(0)
  // biome-ignore lint/correctness/useExhaustiveDependencies: revision and retry intentionally invalidate the request.
  useEffect(() => {
    const controller = new AbortController()
    let current = true
    let pending = false
    const load = async (foreground: boolean) => {
      if (pending) return
      pending = true
      dispatch({ type: "start", source, foreground })
      try {
        const value = await source.api.get<T>(source.path, controller.signal)
        if (current) dispatch({ type: "loaded", source, value })
      } catch (error) {
        if (current && !controller.signal.aborted) {
          dispatch({ type: "failed", source, error: errorMessage(error) })
        }
      } finally {
        pending = false
        if (current) dispatch({ type: "settled", source, foreground })
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
  }, [source, revision, retry, live])
  const { data, error, loading } = resourceFor(state, source)
  return { data, error, loading, reload: useCallback(() => setRetry((n) => n + 1), []) }
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

/* -------------------------------------------------------------------------------------------------
 * Small pieces every screen repeats
 * -----------------------------------------------------------------------------------------------*/

export const ErrorNotice = ({ error, retry }: { error: string | null; retry?: () => void }) =>
  error ? (
    <ErrorState
      title="Request failed"
      error={error}
      retryLabel="Try again"
      {...(retry ? { onRetry: retry } : {})}
    />
  ) : null

export const Json = ({ value, label }: { value: unknown; label?: string }) => (
  <JsonView value={value} label={label ?? "JSON"} maxHeight="28rem" />
)

export const Refresh = ({ loading, onClick }: { loading: boolean; onClick: () => void }) => (
  <Button variant="secondary" size="sm" isPending={loading} onPress={onClick}>
    <ArrowRotateRight className="size-4" />
    Refresh
  </Button>
)

/** A text field with a visible label, an optional hint and validation, as one HeroUI TextField. */
export function TextInput({
  label,
  description,
  value,
  onChange,
  placeholder,
  name,
  ariaLabel,
  type,
  isRequired,
  isDisabled,
  validate,
  rows,
  className,
  monospace,
  onKeyDown,
}: {
  label?: ReactNode
  description?: ReactNode
  value: string
  onChange: (value: string) => void
  placeholder?: string
  name?: string
  ariaLabel?: string
  type?: "text" | "password"
  isRequired?: boolean
  isDisabled?: boolean
  validate?: (value: string) => string | null | undefined
  /** A multi-line text area of this many rows. */
  rows?: number
  className?: string
  monospace?: boolean
  onKeyDown?: (event: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => void
}) {
  const fieldClass = monospace ? { className: "font-mono text-[13px]" } : {}
  return (
    <TextField
      value={value}
      onChange={onChange}
      className={`min-w-0 ${className ?? ""}`.trim()}
      {...(name ? { name } : {})}
      {...(ariaLabel ? { "aria-label": ariaLabel } : {})}
      {...(type ? { type } : {})}
      {...(isRequired ? { isRequired } : {})}
      {...(isDisabled ? { isDisabled } : {})}
      {...(validate ? { validate: (next: string) => validate(next) ?? null } : {})}
    >
      {label ? <Label>{label}</Label> : null}
      {rows ? (
        <TextArea
          rows={rows}
          spellCheck={false}
          {...fieldClass}
          {...(onKeyDown ? { onKeyDown } : {})}
          {...(placeholder ? { placeholder } : {})}
        />
      ) : (
        <Input
          autoComplete="off"
          {...fieldClass}
          {...(onKeyDown ? { onKeyDown } : {})}
          {...(placeholder ? { placeholder } : {})}
        />
      )}
      {description ? <Description>{description}</Description> : null}
      <FieldError />
    </TextField>
  )
}

/** A HeroUI NumberField; an empty field is `null`. */
export function NumberInput({
  label,
  description,
  ariaLabel,
  value,
  onChange,
  minValue,
  maxValue,
  step,
  placeholder,
  className,
}: {
  label?: ReactNode
  description?: ReactNode
  ariaLabel?: string
  value: number | null
  onChange: (value: number | null) => void
  minValue?: number
  maxValue?: number
  step?: number
  placeholder?: string
  className?: string
}) {
  return (
    <NumberField
      value={value ?? Number.NaN}
      onChange={(next) => onChange(Number.isNaN(next) ? null : next)}
      className={`min-w-0 ${className ?? ""}`.trim()}
      {...(ariaLabel ? { "aria-label": ariaLabel } : {})}
      {...(minValue !== undefined ? { minValue } : {})}
      {...(maxValue !== undefined ? { maxValue } : {})}
      {...(step !== undefined ? { step } : { formatOptions: { maximumFractionDigits: 0 } })}
    >
      {label ? <Label>{label}</Label> : null}
      <NumberField.Group>
        <NumberField.DecrementButton />
        <NumberField.Input {...(placeholder ? { placeholder } : {})} />
        <NumberField.IncrementButton />
      </NumberField.Group>
      {description ? <Description>{description}</Description> : null}
    </NumberField>
  )
}

/** A HeroUI Switch with its label beside it. */
export function Toggle({
  label,
  ariaLabel,
  isSelected,
  onChange,
  isDisabled,
}: {
  label: ReactNode
  ariaLabel?: string
  isSelected: boolean
  onChange: (selected: boolean) => void
  isDisabled?: boolean
}) {
  return (
    <Switch
      isSelected={isSelected}
      onChange={onChange}
      {...(ariaLabel ? { "aria-label": ariaLabel } : {})}
      {...(isDisabled ? { isDisabled } : {})}
    >
      <Switch.Content>
        <Switch.Control>
          <Switch.Thumb />
        </Switch.Control>
        <Label>{label}</Label>
      </Switch.Content>
    </Switch>
  )
}

/** A small titled group of fields inside a form. */
export function FieldGroup({ title, children }: { title: string; children: ReactNode }) {
  return (
    <fieldset className="flex min-w-0 flex-col gap-3">
      <legend className="mb-3 text-sm font-semibold text-foreground">{title}</legend>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">{children}</div>
    </fieldset>
  )
}

export type Choice = { value: string; label: string }

/** A HeroUI Select over a short list of string choices. */
export function Choose({
  label,
  ariaLabel,
  value,
  onChange,
  choices,
  placeholder,
  isDisabled,
  className,
  description,
}: {
  label?: ReactNode
  ariaLabel?: string
  value: string | null
  onChange: (value: string) => void
  choices: readonly Choice[]
  placeholder?: string
  isDisabled?: boolean
  className?: string
  description?: ReactNode
}) {
  const portal = usePortal()
  return (
    <Select
      selectedKey={value}
      onSelectionChange={(key) => {
        if (key !== null) onChange(String(key))
      }}
      className={`min-w-0 ${className ?? ""}`.trim()}
      {...(ariaLabel ? { "aria-label": ariaLabel } : {})}
      {...(placeholder ? { placeholder } : {})}
      {...(isDisabled ? { isDisabled } : {})}
    >
      {label ? <Label>{label}</Label> : null}
      <Select.Trigger>
        <Select.Value />
        <Select.Indicator />
      </Select.Trigger>
      {description ? <Description>{description}</Description> : null}
      <Select.Popover {...portal}>
        <ListBox>
          {choices.map((choice) => (
            <ListBox.Item key={choice.value} id={choice.value} textValue={choice.label}>
              {choice.label}
              <ListBox.ItemIndicator />
            </ListBox.Item>
          ))}
        </ListBox>
      </Select.Popover>
    </Select>
  )
}

/** A HeroUI ComboBox: a choice from a longer list, narrowed by typing. */
export function SearchSelect({
  label,
  ariaLabel,
  value,
  onChange,
  choices,
  placeholder,
  isDisabled,
  className,
}: {
  label?: ReactNode
  ariaLabel?: string
  value: string | null
  onChange: (value: string) => void
  choices: readonly Choice[]
  placeholder?: string
  isDisabled?: boolean
  className?: string
}) {
  const portal = usePortal()
  return (
    <ComboBox
      selectedKey={value}
      onSelectionChange={(key) => {
        if (key !== null) onChange(String(key))
      }}
      className={`min-w-0 ${className ?? ""}`.trim()}
      {...(ariaLabel ? { "aria-label": ariaLabel } : {})}
      {...(isDisabled ? { isDisabled } : {})}
    >
      {label ? <Label>{label}</Label> : null}
      <ComboBox.InputGroup>
        <Input {...(placeholder ? { placeholder } : {})} />
        <ComboBox.Trigger />
      </ComboBox.InputGroup>
      <ComboBox.Popover {...portal}>
        <ListBox>
          {choices.map((choice) => (
            <ListBox.Item key={choice.value} id={choice.value} textValue={choice.label}>
              {choice.label}
              <ListBox.ItemIndicator />
            </ListBox.Item>
          ))}
        </ListBox>
      </ComboBox.Popover>
    </ComboBox>
  )
}

/* -------------------------------------------------------------------------------------------------
 * DataTable
 * -----------------------------------------------------------------------------------------------*/

type GridProps = {
  rows: Record<string, unknown>[]
  columns?: readonly string[]
  rowKeys?: readonly string[]
  /** Column widths in pixels, by name: a cell is cut off with an ellipsis past it. Default: 240. */
  widths?: Readonly<Record<string, number>>
  loading?: boolean
  total?: number
  page?: number
  pageSize?: number
  onPage?: (page: number, size: number) => void
  pagination?: false
  action?: (row: Record<string, unknown>, index: number) => ReactNode
  actionWidth?: number
  /** What a row's details show. Default: the row itself. */
  detail?: (row: Record<string, unknown>, index: number) => unknown
  /** The table's accessible name. */
  label?: string
  /** Hide the search box (small fixed tables). */
  searchable?: boolean
}

const PAGE_SIZES = [25, 50, 100, 200]

const cell = (value: unknown): ReactNode =>
  value === null ? (
    <span className="text-muted">NULL</span>
  ) : value === undefined ? (
    <span className="text-muted">—</span>
  ) : typeof value === "boolean" ? (
    <span className="font-mono text-[13px]">{String(value)}</span>
  ) : (
    text(value)
  )

/** The page links: first, last, and the pages around the current one. */
const pageList = (current: number, last: number): (number | "gap")[] => {
  const pages = new Set([1, last, current - 1, current, current + 1])
  const list = [...pages].filter((page) => page >= 1 && page <= last).sort((a, b) => a - b)
  return list.flatMap((page, index) =>
    index > 0 && page - (list[index - 1] ?? page) > 1 ? ["gap" as const, page] : [page],
  )
}

/**
 * Structured data as a HeroUI Table: a search box over the loaded rows, sortable columns,
 * pagination (in memory, or by the server with `onPage`), and each row's full JSON in a dialog.
 */
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
  detail,
  label = "Records",
  searchable = true,
}: GridProps) {
  const portal = usePortal()
  const [search, setSearch] = useState("")
  const [sort, setSort] = useState<SortDescriptor | undefined>(undefined)
  const [localPage, setLocalPage] = useState(1)
  const [localSize, setLocalSize] = useState(pageSize)
  const [shown, setShown] = useState<number | null>(null)
  const names = columns ?? [...new Set(rows.flatMap((row) => Object.keys(row)))]
  const query = search.toLocaleLowerCase()
  const data = rows
    .map((value, index) => ({ key: rowKeys?.[index] ?? String(index), index, value }))
    .filter((row) => !query || text(row.value).toLocaleLowerCase().includes(query))
  if (sort?.column !== undefined) {
    const name = String(sort.column)
    const direction = sort.direction === "descending" ? -1 : 1
    data.sort(
      (a, b) =>
        direction *
        text(a.value[name]).localeCompare(text(b.value[name]), undefined, { numeric: true }),
    )
  }
  const server = onPage !== undefined
  const size = server ? pageSize : localSize
  const count = server ? (total ?? rows.length) : data.length
  const last = Math.max(1, Math.ceil(count / size))
  const current = Math.min(server ? (page ?? 1) : localPage, last)
  const visible =
    pagination === false || server ? data : data.slice((current - 1) * size, current * size)
  const go = (next: number, nextSize = size) => {
    if (server) onPage(next, nextSize)
    else {
      setLocalPage(next)
      setLocalSize(nextSize)
    }
  }
  const detailRow = shown === null ? undefined : rows[shown]
  return (
    <div className="flex min-w-0 flex-col gap-3">
      {searchable ? (
        <SearchField
          aria-label="Search loaded rows"
          value={search}
          onChange={(next) => {
            setSearch(next)
            setLocalPage(1)
          }}
          className="w-full max-w-sm"
        >
          <SearchField.Group>
            <SearchField.SearchIcon />
            <SearchField.Input placeholder="Search loaded rows" />
            <SearchField.ClearButton />
          </SearchField.Group>
        </SearchField>
      ) : null}
      <Table>
        <Table.ScrollContainer>
          <Table.Content
            aria-label={label}
            {...(sort ? { sortDescriptor: sort } : {})}
            onSortChange={setSort}
            className="min-w-full"
          >
            <Table.Header>
              {[
                ...names.map((name, index) => (
                  <Table.Column key={name} id={name} allowsSorting isRowHeader={index === 0}>
                    {({ sortDirection }) => (
                      <Table.SortableColumnHeader
                        {...(sortDirection ? { sortDirection } : {})}
                        className="whitespace-nowrap"
                      >
                        {name}
                      </Table.SortableColumnHeader>
                    )}
                  </Table.Column>
                )),
                // React Aria needs a row header; with no data columns it is this one.
                <Table.Column
                  key="__actions"
                  id="__actions"
                  isRowHeader={names.length === 0}
                  className="w-0 text-end"
                >
                  <span className="sr-only">Actions</span>
                </Table.Column>,
              ]}
            </Table.Header>
            <Table.Body
              renderEmptyState={() =>
                loading ? (
                  <div className="flex justify-center py-8">
                    <Spinner size="md" aria-label="Loading rows" />
                  </div>
                ) : (
                  <EmptyState title={query ? "No matching rows on this page" : "No records"} />
                )
              }
            >
              {visible.map((row) => (
                <Table.Row key={row.key} id={row.key}>
                  {[
                    ...names.map((name) => {
                      const full = text(row.value[name])
                      return (
                        <Table.Cell key={name}>
                          <div
                            className="truncate"
                            style={{ maxWidth: widths?.[name] ?? 240 }}
                            title={full}
                          >
                            {cell(row.value[name])}
                          </div>
                        </Table.Cell>
                      )
                    }),
                    <Table.Cell key="__actions">
                      <div className="flex items-center justify-end gap-1 whitespace-nowrap">
                        {action?.(row.value, row.index)}
                        <Button
                          isIconOnly
                          size="sm"
                          variant="ghost"
                          aria-label={`Details of row ${row.index + 1}`}
                          onPress={() => setShown(row.index)}
                        >
                          <Eye className="size-4" />
                        </Button>
                      </div>
                    </Table.Cell>,
                  ]}
                </Table.Row>
              ))}
            </Table.Body>
          </Table.Content>
        </Table.ScrollContainer>
        {pagination === false ? null : (
          <Table.Footer>
            <Pagination size="sm" className="flex w-full flex-wrap items-center gap-3">
              <Pagination.Summary>
                {count} {server ? "records" : "loaded records"}
              </Pagination.Summary>
              <Pagination.Content>
                <Pagination.Item>
                  <Pagination.Previous
                    isDisabled={current <= 1 || loading}
                    onPress={() => go(current - 1)}
                  >
                    <Pagination.PreviousIcon />
                    <span className="sr-only">Previous page</span>
                  </Pagination.Previous>
                </Pagination.Item>
                {pageList(current, last).map((item, index) =>
                  item === "gap" ? (
                    // biome-ignore lint/suspicious/noArrayIndexKey: gaps have no identity of their own.
                    <Pagination.Item key={`gap-${index}`}>
                      <Pagination.Ellipsis />
                    </Pagination.Item>
                  ) : (
                    <Pagination.Item key={item}>
                      <Pagination.Link
                        isActive={item === current}
                        aria-label={`Page ${item}`}
                        onPress={() => go(item)}
                      >
                        {item}
                      </Pagination.Link>
                    </Pagination.Item>
                  ),
                )}
                <Pagination.Item>
                  <Pagination.Next
                    isDisabled={current >= last || loading}
                    onPress={() => go(current + 1)}
                  >
                    <span className="sr-only">Next page</span>
                    <Pagination.NextIcon />
                  </Pagination.Next>
                </Pagination.Item>
              </Pagination.Content>
              <Choose
                ariaLabel="Rows per page"
                value={String(size)}
                onChange={(next) => go(1, Number(next))}
                choices={PAGE_SIZES.map((value) => ({
                  value: String(value),
                  label: `${value} / page`,
                }))}
                className="w-32"
              />
            </Pagination>
          </Table.Footer>
        )}
      </Table>
      <Modal.Backdrop
        isOpen={detailRow !== undefined}
        onOpenChange={(open) => {
          if (!open) setShown(null)
        }}
        {...portal}
      >
        <Modal.Container size="lg" scroll="inside">
          <Modal.Dialog>
            <Modal.CloseTrigger />
            <Modal.Header>
              <Modal.Heading>Row details</Modal.Heading>
            </Modal.Header>
            <Modal.Body>
              {detailRow !== undefined && shown !== null ? (
                <Json value={detail ? detail(detailRow, shown) : detailRow} />
              ) : null}
            </Modal.Body>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </div>
  )
}
