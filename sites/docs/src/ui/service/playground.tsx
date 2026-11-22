import { StatusChip } from "@crvouga/mockingbird-ui/react"
import {
  Button,
  Card,
  Disclosure,
  InputGroup,
  Kbd,
  ListBox,
  SearchField,
  Select,
  Spinner,
  Tabs,
  TextArea,
} from "@heroui/react"
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react"
import { formatBytes, highlightJson } from "../../client/render.ts"
import type { Operation } from "../../lib/types.ts"
import { Icon } from "../icon.tsx"
import { MethodChip } from "./method.tsx"
import { modEnterLabel, runtimeLoader, warm } from "./runtime.ts"

interface Runtime {
  fetch(request: Request): Promise<Response>
  reset(namespace?: string): Promise<void>
  snapshot(namespace?: string): { records?: { collection: string; id: string; value: string }[] }
}

const REASONS: Record<number, string> = {
  200: "OK",
  201: "Created",
  202: "Accepted",
  204: "No Content",
  301: "Moved Permanently",
  302: "Found",
  303: "See Other",
  304: "Not Modified",
  400: "Bad Request",
  401: "Unauthorized",
  402: "Payment Required",
  403: "Forbidden",
  404: "Not Found",
  405: "Method Not Allowed",
  409: "Conflict",
  410: "Gone",
  413: "Payload Too Large",
  415: "Unsupported Media Type",
  422: "Unprocessable Entity",
  429: "Too Many Requests",
  500: "Internal Server Error",
  502: "Bad Gateway",
  503: "Service Unavailable",
  504: "Gateway Timeout",
}

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]

export type PlaygroundProps = {
  service: string
  packageName: string
  origin: string | null
  /** The operation it opens on. */
  operation: string | null
  /** The supported operations, with their sample requests. */
  operations: Operation[]
  authHint: string | null
}

type Status = { state: "idle" | "loading" | "ready" | "error"; text: string }

type Result =
  | { kind: "empty"; text: string }
  | { kind: "error"; text: string }
  | {
      kind: "response"
      status: number
      statusText: string
      ok: boolean
      ms: number
      bytes: number
      headers: [string, string][]
      body:
        | { kind: "json"; html: string }
        | { kind: "text"; text: string }
        | { kind: "media"; type: "audio" | "image" | "video"; url: string }
    }

type StateGroup = { name: string; values: unknown[] }
type JournalRow = {
  method: string
  path: string
  status: string
  ok: boolean
  operation: string
  ms: string
}

const headerText = (h: Record<string, string>) =>
  Object.entries(h)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n")

const parseHeaders = (text: string): Headers => {
  const h = new Headers()
  for (const line of text.split("\n")) {
    const i = line.indexOf(":")
    if (i > 0) h.set(line.slice(0, i).trim(), line.slice(i + 1).trim())
  }
  return h
}

const collectIds = (value: unknown): string[] => {
  const found: string[] = []
  const walk = (v: unknown, depth: number) => {
    if (!v || typeof v !== "object" || depth > 3 || found.length > 6) return
    for (const [k, inner] of Object.entries(v)) {
      if (
        /^(id|.*_id|.*Id|sid|uuid)$/.test(k) &&
        (typeof inner === "string" || typeof inner === "number")
      ) {
        found.push(String(inner))
      } else walk(inner, depth + 1)
    }
  }
  walk(value, 0)
  return found
}

const findToken = (value: unknown): string | null => {
  if (!value || typeof value !== "object") return null
  for (const [k, v] of Object.entries(value)) {
    if (/^(access_?token|jwt_?token|token)$/i.test(k) && typeof v === "string" && v.length > 8)
      return v
  }
  return null
}

const OUTPUT =
  "max-h-[28rem] min-h-40 overflow-auto rounded-lg border border-border bg-surface-secondary p-3 font-mono text-[13px] leading-relaxed whitespace-pre"

function Muted({ children }: { children: ReactNode }) {
  return <span className="font-sans text-sm text-muted">{children}</span>
}

/**
 * The live playground of an HTTP emulator: the real package, loaded into this tab on the first
 * request, with its operations, a request editor, and the response, state and journal it keeps.
 * The "Try" buttons of the operations table (`data-try-op`) open an operation here.
 */
export function Playground(props: PlaygroundProps) {
  const { service, packageName, origin, operations } = props
  const root = useRef<HTMLDivElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const pathInput = useRef<HTMLInputElement>(null)
  const runtime = useRef<Promise<Runtime> | undefined>(undefined)

  const [modEnter, setModEnter] = useState("⌘↵")
  useEffect(() => setModEnter(modEnterLabel()), [])
  const [status, setStatus] = useState<Status>({
    state: "idle",
    text: `Loads the real ${packageName} into this tab on first send`,
  })
  const [selected, setSelected] = useState<string | null>(null)
  const [filter, setFilter] = useState("")
  const [method, setMethod] = useState("GET")
  const [path, setPath] = useState("")
  const [body, setBody] = useState("")
  const [headers, setHeaders] = useState("")
  const [requestTab, setRequestTab] = useState<string>("body")
  const [responseTab, setResponseTab] = useState<string>("response")
  const [sending, setSending] = useState(false)
  const [result, setResult] = useState<Result>({
    kind: "empty",
    text: "Send a request to see the emulator's response.",
  })
  const [stateGroups, setStateGroups] = useState<StateGroup[] | string | null>(null)
  const [journal, setJournal] = useState<JournalRow[] | string | null>(null)
  const [lastIds, setLastIds] = useState<string[]>([])
  const [token, setToken] = useState<string | null>(null)
  const [offeredToken, setOfferedToken] = useState<string | null>(null)

  const op = operations.find((o) => o.id === selected)
  const placeholder = /\{([^}]+)\}/.exec(path)?.[1]

  const start = useCallback((): Promise<Runtime> => {
    runtime.current ??= (async () => {
      const load = await runtimeLoader(service)
      if (!load) throw new Error(`No browser build for ${service}`)
      setStatus({ state: "loading", text: "Loading the emulator…" })
      const t0 = performance.now()
      const mod = await load()
      const rt = mod.createRuntime() as Runtime
      setStatus({
        state: "ready",
        text: `Running in this tab · loaded in ${Math.round(performance.now() - t0)} ms · no network`,
      })
      return rt
    })().catch((error: Error) => {
      runtime.current = undefined
      setStatus({ state: "error", text: `Could not load the emulator: ${error.message}` })
      throw error
    })
    return runtime.current
  }, [service])

  const select = useCallback(
    (id: string, options: { focus?: boolean; remember?: boolean } = {}) => {
      const next = operations.find((o) => o.id === id)
      if (!next) return
      setSelected(id)
      setMethod(next.method)
      setPath(`${next.path}${next.query ? `?${next.query}` : ""}`)
      setBody(next.body)
      const h = { ...next.headers }
      if (token && "authorization" in h) h.authorization = `Bearer ${token}`
      setHeaders(headerText(h))
      if (options.remember ?? true) {
        const url = new URL(location.href)
        url.searchParams.set("op", id)
        history.replaceState(null, "", url)
      }
      requestAnimationFrame(() => {
        // Scroll the list only, never the page: the page may be anywhere.
        const box = list.current
        const item = box?.querySelector<HTMLElement>(`[data-key="${CSS.escape(id)}"]`)
        if (box && item) {
          const top = item.offsetTop
          if (top < box.scrollTop) box.scrollTop = top
          else if (top + item.offsetHeight > box.scrollTop + box.clientHeight)
            box.scrollTop = top + item.offsetHeight - box.clientHeight
        }
        if (options.focus) pathInput.current?.focus()
      })
    },
    [operations, token],
  )

  const refreshSide = useCallback(
    async (rt: Runtime) => {
      try {
        const records = rt.snapshot().records ?? []
        const groups = new Map<string, unknown[]>()
        for (const r of records) {
          let value: unknown = r.value
          try {
            const parsed = JSON.parse(r.value)
            value = parsed?.value ?? parsed
          } catch {}
          const bucket = groups.get(r.collection) ?? []
          bucket.push(value)
          groups.set(r.collection, bucket)
        }
        setStateGroups([...groups].map(([name, values]) => ({ name, values })))
      } catch (error) {
        setStateGroups(`Snapshot unavailable: ${(error as Error).message}`)
      }
      try {
        const res = await rt.fetch(new Request(`${origin}/__admin/requests`))
        const data = (await res.json()) as { requests?: Record<string, unknown>[] }
        setJournal(
          (data.requests ?? [])
            .slice(-50)
            .reverse()
            .map((r) => ({
              method: String(r.method),
              path: String(r.path),
              status: String(r.status),
              ok: Number(r.status) < 400,
              operation: String(r.operationId ?? "unmatched"),
              ms: String(r.durationMs),
            })),
        )
      } catch {
        setJournal("This emulator does not expose a request journal.")
      }
    },
    [origin],
  )

  const run = useCallback(async () => {
    setSending(true)
    setResult({ kind: "empty", text: "Sending…" })
    setOfferedToken(null)
    try {
      const rt = await start()
      const hasBody = method !== "GET" && method !== "HEAD" && body.trim() !== ""
      const request = new Request(`${origin}${path.startsWith("/") ? "" : "/"}${path}`, {
        method,
        headers: parseHeaders(headers),
        ...(hasBody ? { body } : {}),
      })
      const t0 = performance.now()
      const res = await rt.fetch(request)
      const ms = performance.now() - t0
      const type = res.headers.get("content-type") ?? ""
      const buf = await res.arrayBuffer()
      let shown: Extract<Result, { kind: "response" }>["body"]
      if (/^(audio|image|video)\//.test(type)) {
        const kind = type.startsWith("audio")
          ? "audio"
          : type.startsWith("image")
            ? "image"
            : "video"
        shown = { kind: "media", type: kind, url: URL.createObjectURL(new Blob([buf], { type })) }
      } else {
        const text = new TextDecoder().decode(buf)
        let parsed: unknown
        try {
          parsed = type.includes("json") || /^\s*[[{]/.test(text) ? JSON.parse(text) : undefined
        } catch {}
        if (parsed !== undefined) {
          shown = { kind: "json", html: highlightJson(parsed) }
          const ids = collectIds(parsed)
          if (ids.length > 0) setLastIds((before) => [...new Set([...ids, ...before])].slice(0, 8))
          const found = findToken(parsed)
          if (found) setOfferedToken(found)
        } else {
          shown = { kind: "text", text: text.length > 20000 ? `${text.slice(0, 20000)}\n…` : text }
        }
      }
      setResult({
        kind: "response",
        status: res.status,
        statusText: res.statusText || REASONS[res.status] || "",
        ok: res.status < 400,
        ms,
        bytes: buf.byteLength,
        headers: [...res.headers],
        body: shown,
      })
      await refreshSide(rt)
    } catch (error) {
      setResult({ kind: "error", text: `${(error as Error).name}: ${(error as Error).message}` })
    } finally {
      setSending(false)
    }
  }, [start, method, body, origin, path, headers, refreshSide])

  const reset = async () => {
    const rt = await start()
    await rt.reset("*")
    setLastIds([])
    setToken(null)
    setOfferedToken(null)
    await refreshSide(rt)
    setResult({ kind: "empty", text: "State reset. The emulator is empty again." })
  }

  const useToken = () => {
    if (!offeredToken) return
    setToken(offeredToken)
    setHeaders((text) =>
      [
        `authorization: Bearer ${offeredToken}`,
        ...text.split("\n").filter((l) => !/^authorization:/i.test(l)),
      ].join("\n"),
    )
  }

  // Open on the operation in the URL (`?op=`), the verified default, or the first.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs once, on mount.
  useEffect(() => {
    const requested = new URLSearchParams(location.search).get("op")
    const initial =
      operations.find((o) => o.id === requested)?.id ?? props.operation ?? operations[0]?.id
    if (initial) {
      select(initial, { remember: Boolean(requested) })
      if (requested) root.current?.scrollIntoView({ block: "start" })
    }
  }, [])

  // The operations table's "Try" buttons live outside this island.
  useEffect(() => {
    const onClick = (event: MouseEvent) => {
      const button = (event.target as Element | null)?.closest?.<HTMLElement>("[data-try-op]")
      const id = button?.dataset.tryOp
      if (!id) return
      select(id)
      root.current?.scrollIntoView({ behavior: "smooth", block: "start" })
    }
    document.addEventListener("click", onClick)
    return () => document.removeEventListener("click", onClick)
  }, [select])

  const visible = useMemo(() => {
    const q = filter.toLowerCase().trim()
    return q === ""
      ? operations
      : operations.filter((o) =>
          [o.id, o.method, o.path, o.summary ?? ""].join(" ").toLowerCase().includes(q),
        )
  }, [operations, filter])

  return (
    <Card
      ref={root}
      className="scroll-mt-20 gap-0 overflow-hidden p-0"
      data-pg
      data-state={status.state}
      onPointerEnter={() => warm(service)}
      onFocus={() => warm(service)}
      onKeyDown={(event) => {
        if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
          event.preventDefault()
          void run()
        }
      }}
    >
      <div className="flex flex-wrap items-center gap-2 border-b border-separator bg-surface-secondary px-3 py-2">
        <PlaygroundStatus status={status} />
        <Button
          variant="ghost"
          size="sm"
          className="ml-auto"
          isDisabled={status.state !== "ready"}
          onPress={() => void reset()}
        >
          <Icon name="reset" /> Reset state
        </Button>
      </div>
      <div className="grid min-w-0 md:grid-cols-[17rem_minmax(0,1fr)]">
        <aside className="flex min-w-0 flex-col gap-2 border-b border-separator p-3 md:border-r md:border-b-0">
          <SearchField aria-label="Filter operations" value={filter} onChange={setFilter} fullWidth>
            <SearchField.Group>
              <SearchField.SearchIcon />
              <SearchField.Input placeholder={`Filter ${operations.length} operations`} />
              <SearchField.ClearButton />
            </SearchField.Group>
          </SearchField>
          <div ref={list} className="relative max-h-64 overflow-y-auto md:max-h-[34rem]">
            <ListBox
              aria-label="Operations"
              selectionMode="single"
              disallowEmptySelection
              selectedKeys={selected ? [selected] : []}
              onSelectionChange={(keys) => {
                const [key] = keys === "all" ? [] : [...keys]
                if (key !== undefined) select(String(key), { focus: true })
              }}
              renderEmptyState={() => (
                <p className="px-2 py-6 text-center text-sm text-muted">No operations match.</p>
              )}
            >
              {visible.map((o) => (
                <ListBox.Item
                  key={o.id}
                  id={o.id}
                  textValue={o.summary ?? o.id}
                  className="items-start gap-2"
                >
                  <MethodChip method={o.method} />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate font-mono text-xs">{o.path}</span>
                    <span className="truncate text-xs text-muted">{o.summary ?? o.id}</span>
                  </span>
                  {o.verified ? (
                    <span
                      className="mt-1.5 size-2 shrink-0 rounded-full bg-success"
                      title="The sample request succeeds against a fresh emulator"
                    />
                  ) : null}
                </ListBox.Item>
              ))}
            </ListBox>
          </div>
        </aside>
        <div className="flex min-w-0 flex-col gap-3 p-3">
          <form
            className="flex flex-wrap items-center gap-2"
            onSubmit={(event) => {
              event.preventDefault()
              void run()
            }}
          >
            <Select
              aria-label="Method"
              className="w-32"
              selectedKey={method}
              onSelectionChange={(key) => key && setMethod(String(key))}
            >
              <Select.Trigger>
                <Select.Value />
                <Select.Indicator />
              </Select.Trigger>
              <Select.Popover>
                <ListBox>
                  {METHODS.map((m) => (
                    <ListBox.Item key={m} id={m} textValue={m}>
                      {m}
                    </ListBox.Item>
                  ))}
                </ListBox>
              </Select.Popover>
            </Select>
            <InputGroup className="min-w-0 flex-[1_1_16rem]">
              <InputGroup.Prefix className="max-w-[45%] truncate font-mono text-xs text-muted">
                {origin}
              </InputGroup.Prefix>
              <InputGroup.Input
                ref={pathInput}
                aria-label="Path and query"
                spellCheck={false}
                autoComplete="off"
                className="font-mono text-sm"
                value={path}
                onChange={(event) => setPath(event.target.value)}
              />
            </InputGroup>
            <Button type="submit" size="md" isPending={sending}>
              {sending ? <Spinner size="sm" color="current" /> : <Icon name="play" />} Send
              <Kbd className="hidden sm:inline-flex">{modEnter}</Kbd>
            </Button>
          </form>
          {op ? (
            <p className="text-sm text-muted">
              <code className="font-mono text-foreground">{op.id}</code>
              {op.summary ? ` · ${op.summary}` : ""}
            </p>
          ) : null}
          {placeholder && lastIds.length > 0 ? (
            <div className="flex flex-wrap items-center gap-1.5 text-sm text-muted">
              Fill <code className="font-mono text-foreground">{`{${placeholder}}`}</code> with an
              id from an earlier response:
              {lastIds.slice(0, 4).map((id) => (
                <Button
                  key={id}
                  size="sm"
                  variant="secondary"
                  className="h-7 font-mono text-xs"
                  onPress={() => setPath((p) => p.replace(/\{[^}]+\}/, encodeURIComponent(id)))}
                >
                  {id}
                </Button>
              ))}
            </div>
          ) : null}
          <Tabs
            variant="secondary"
            selectedKey={requestTab}
            onSelectionChange={(key) => setRequestTab(String(key))}
          >
            <Tabs.ListContainer>
              <Tabs.List aria-label="Request">
                <Tabs.Tab id="body">
                  Body
                  <Tabs.Indicator />
                </Tabs.Tab>
                <Tabs.Tab id="headers">
                  Headers
                  <Tabs.Indicator />
                </Tabs.Tab>
              </Tabs.List>
            </Tabs.ListContainer>
            <Tabs.Panel id="body" className="px-0 pb-0">
              <TextArea
                aria-label="Request body"
                placeholder="No body"
                spellCheck={false}
                fullWidth
                rows={8}
                className="font-mono text-[13px]"
                value={body}
                onChange={(event) => setBody(event.target.value)}
              />
            </Tabs.Panel>
            <Tabs.Panel id="headers" className="px-0 pb-0">
              <TextArea
                aria-label="Request headers, one per line"
                spellCheck={false}
                fullWidth
                rows={8}
                className="font-mono text-[13px]"
                value={headers}
                onChange={(event) => setHeaders(event.target.value)}
              />
            </Tabs.Panel>
          </Tabs>
          {op?.bodyNote ? <p className="text-sm text-muted">{op.bodyNote}</p> : null}
          {props.authHint ? (
            <p className="flex items-start gap-2 text-sm text-muted">
              <Icon name="key" className="mt-0.5 size-4 shrink-0" />
              <span>{props.authHint}</span>
            </p>
          ) : null}
          <Tabs
            variant="secondary"
            selectedKey={responseTab}
            onSelectionChange={(key) => setResponseTab(String(key))}
          >
            <Tabs.ListContainer>
              <Tabs.List aria-label="Result">
                <Tabs.Tab id="response">
                  Response
                  <Tabs.Indicator />
                </Tabs.Tab>
                <Tabs.Tab id="state">
                  State
                  <Tabs.Indicator />
                </Tabs.Tab>
                <Tabs.Tab id="journal">
                  Journal
                  <Tabs.Indicator />
                </Tabs.Tab>
              </Tabs.List>
            </Tabs.ListContainer>
            <Tabs.Panel id="response" className="flex flex-col gap-2 px-0 pb-0">
              {result.kind === "response" ? (
                <span className="flex items-center gap-3 text-xs text-muted">
                  <StatusChip status={result.ok ? "ok" : "error"}>
                    {result.status} {result.statusText}
                  </StatusChip>
                  <span>{result.ms.toFixed(1)} ms</span>
                  <span>{formatBytes(result.bytes)}</span>
                </span>
              ) : result.kind === "error" ? (
                <span>
                  <StatusChip status="error">Error</StatusChip>
                </span>
              ) : null}
              {offeredToken ? (
                <div className="flex flex-wrap items-center gap-2 text-sm text-muted">
                  {token === offeredToken ? (
                    <span>Using the issued token for every request on this page.</span>
                  ) : (
                    <>
                      <span>This response issued a token.</span>
                      <Button size="sm" variant="secondary" onPress={useToken}>
                        Use it as the bearer token
                      </Button>
                    </>
                  )}
                </div>
              ) : null}
              <ResponseView result={result} />
            </Tabs.Panel>
            <Tabs.Panel id="state" className="px-0 pb-0">
              <div className={`${OUTPUT} whitespace-normal`}>
                {stateGroups === null ? (
                  <Muted>Records the emulator holds appear here after a request.</Muted>
                ) : typeof stateGroups === "string" ? (
                  <Muted>{stateGroups}</Muted>
                ) : stateGroups.length === 0 ? (
                  <Muted>The emulator holds no records yet.</Muted>
                ) : (
                  stateGroups.map((group) => (
                    <Disclosure key={group.name} defaultExpanded={stateGroups.length < 4}>
                      <Disclosure.Heading>
                        <Disclosure.Trigger className="flex w-full items-center gap-2 py-1 font-sans text-sm">
                          <strong>{group.name}</strong>
                          <span className="text-muted">
                            {group.values.length} record{group.values.length === 1 ? "" : "s"}
                          </span>
                          <Disclosure.Indicator className="ml-auto" />
                        </Disclosure.Trigger>
                      </Disclosure.Heading>
                      <Disclosure.Content>
                        <Disclosure.Body
                          className="pb-2 whitespace-pre"
                          dangerouslySetInnerHTML={{
                            __html: highlightJson(group.values.slice(-20)),
                          }}
                        />
                      </Disclosure.Content>
                    </Disclosure>
                  ))
                )}
              </div>
            </Tabs.Panel>
            <Tabs.Panel id="journal" className="px-0 pb-0">
              <div className={`${OUTPUT} whitespace-normal`}>
                {journal === null ? (
                  <Muted>
                    Every request the emulator received, from its own /__admin/requests journal.
                  </Muted>
                ) : typeof journal === "string" ? (
                  <Muted>{journal}</Muted>
                ) : journal.length === 0 ? (
                  <Muted>No requests yet.</Muted>
                ) : (
                  <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
                    {journal.map((row, i) => (
                      <li
                        // biome-ignore lint/suspicious/noArrayIndexKey: the journal is append-only.
                        key={i}
                        className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs"
                      >
                        <MethodChip method={row.method} />
                        <span className="min-w-0 break-all text-foreground">{row.path}</span>
                        <StatusChip status={row.ok ? "ok" : "error"}>{row.status}</StatusChip>
                        <span className="font-sans text-muted">
                          {row.operation} · {row.ms} ms
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </Tabs.Panel>
          </Tabs>
        </div>
      </div>
    </Card>
  )
}

function PlaygroundStatus({ status }: { status: Status }) {
  return (
    <span className="flex min-w-0 items-center gap-2 text-sm text-muted" role="status">
      {status.state === "loading" ? (
        <Spinner size="sm" />
      ) : (
        <StatusChip
          status={status.state === "ready" ? "ok" : status.state === "error" ? "error" : "neutral"}
          dot
        >
          {status.state === "ready" ? "Live" : status.state === "error" ? "Error" : "Idle"}
        </StatusChip>
      )}
      <span className="min-w-0">{status.text}</span>
    </span>
  )
}

function ResponseView({ result }: { result: Result }) {
  if (result.kind === "empty")
    return (
      <div className={OUTPUT}>
        <Muted>{result.text}</Muted>
      </div>
    )
  if (result.kind === "error") return <div className={`${OUTPUT} text-danger`}>{result.text}</div>
  const { body } = result
  return (
    <div className={OUTPUT}>
      <Disclosure>
        <Disclosure.Heading>
          <Disclosure.Trigger className="flex items-center gap-1 pb-2 font-sans text-xs text-muted">
            Headers
            <Disclosure.Indicator />
          </Disclosure.Trigger>
        </Disclosure.Heading>
        <Disclosure.Content>
          <Disclosure.Body className="pb-3 text-xs">
            {result.headers.map(([k, v]) => (
              <div key={k}>
                <span className="text-accent">{k}:</span> {v}
              </div>
            ))}
          </Disclosure.Body>
        </Disclosure.Content>
      </Disclosure>
      {body.kind === "json" ? (
        <div dangerouslySetInnerHTML={{ __html: body.html }} />
      ) : body.kind === "text" ? (
        body.text ? (
          <div>{body.text}</div>
        ) : (
          <Muted>(empty body)</Muted>
        )
      ) : body.type === "audio" ? (
        // biome-ignore lint/a11y/useMediaCaption: an emulator's synthesized audio has no captions.
        <audio controls src={body.url} />
      ) : body.type === "image" ? (
        <img alt="Response" src={body.url} className="max-w-full" />
      ) : (
        // biome-ignore lint/a11y/useMediaCaption: an emulator's generated video has no captions.
        <video controls src={body.url} className="max-w-full" />
      )}
    </div>
  )
}
