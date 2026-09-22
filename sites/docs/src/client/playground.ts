import { loaders } from "virtual:mockingbird/runtimes"
import type { Operation } from "../lib/types.ts"
import { escapeHtml, formatBytes, highlightJson } from "./render.ts"

interface Data {
  service: string
  origin: string | null
  operation: string | null
  operations: Operation[]
}

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

const root = document.querySelector<HTMLElement>("[data-pg]")
const raw = root?.querySelector("[data-pg-data]")?.textContent

if (root && raw) {
  const data = JSON.parse(raw) as Data
  const $ = <T extends Element>(sel: string) => root.querySelector<T>(sel) as T
  const method = $<HTMLSelectElement>("[data-pg-method]")
  const path = $<HTMLInputElement>("[data-pg-path]")
  const body = $<HTMLTextAreaElement>("[data-pg-body]")
  const headers = $<HTMLTextAreaElement>("[data-pg-headers]")
  const summary = $<HTMLElement>("[data-pg-summary]")
  const note = $<HTMLElement>("[data-pg-note]")
  const fill = $<HTMLElement>("[data-pg-fill]")
  const status = $<HTMLElement>("[data-pg-status]")
  const statusText = $<HTMLElement>("[data-pg-status-text]")
  const meta = $<HTMLElement>("[data-pg-meta]")
  const out = $<HTMLElement>("[data-pg-response]")
  const tokenBox = $<HTMLElement>("[data-pg-token]")
  const stateOut = $<HTMLElement>("[data-pg-state]")
  const journalOut = $<HTMLElement>("[data-pg-journal]")
  const reset = $<HTMLButtonElement>("[data-pg-reset]")
  const send = $<HTMLButtonElement>("[data-pg-send]")
  const list = $<HTMLUListElement>("[data-pg-list]")
  const filter = $<HTMLInputElement>("[data-pg-filter]")

  let runtime: Promise<Runtime> | undefined
  let lastIds: string[] = []
  let token: string | null = null

  const setStatus = (state: "idle" | "loading" | "ready" | "error", text: string) => {
    status.dataset.state = state
    statusText.textContent = text
  }

  const start = (): Promise<Runtime> => {
    runtime ??= (async () => {
      const load = loaders[data.service]
      if (!load) throw new Error(`No browser build for ${data.service}`)
      setStatus("loading", "Loading the mock…")
      const t0 = performance.now()
      const mod = await load()
      const rt = mod.createRuntime() as Runtime
      setStatus(
        "ready",
        `Running in this tab · loaded in ${Math.round(performance.now() - t0)} ms · no network`,
      )
      reset.disabled = false
      return rt
    })().catch((error: Error) => {
      runtime = undefined
      setStatus("error", `Could not load the mock: ${error.message}`)
      throw error
    })
    return runtime
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

  const updateFill = () => {
    const placeholder = /\{([^}]+)\}/.exec(path.value)
    if (!placeholder || lastIds.length === 0) {
      fill.hidden = true
      return
    }
    fill.hidden = false
    fill.innerHTML = `Fill <code>{${escapeHtml(placeholder[1] ?? "")}}</code> with an id from an earlier response: ${lastIds
      .slice(0, 4)
      .map(
        (id) =>
          `<button type="button" class="chip-sm" data-fill="${escapeHtml(id)}">${escapeHtml(id)}</button>`,
      )
      .join(" ")}`
  }

  const select = (id: string, focus = false, remember = true) => {
    const op = data.operations.find((o) => o.id === id)
    if (!op) return
    method.value = op.method
    path.value = `${op.path}${op.query ? `?${op.query}` : ""}`
    body.value = op.body
    const h = { ...op.headers }
    if (token && "authorization" in h) h.authorization = `Bearer ${token}`
    headers.value = headerText(h)
    summary.innerHTML = `<code>${escapeHtml(op.id)}</code>${op.summary ? ` · ${escapeHtml(op.summary)}` : ""}`
    note.hidden = !op.bodyNote
    note.textContent = op.bodyNote ?? ""
    for (const b of list.querySelectorAll<HTMLButtonElement>("[data-op]")) {
      const on = b.dataset.op === id
      b.setAttribute("aria-current", String(on))
      if (on) b.scrollIntoView({ block: "nearest" })
    }
    updateFill()
    if (remember) {
      const url = new URL(location.href)
      url.searchParams.set("op", id)
      history.replaceState(null, "", url)
    }
    if (focus) path.focus()
  }

  const collectIds = (value: unknown) => {
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
    if (found.length > 0) lastIds = [...new Set([...found, ...lastIds])].slice(0, 8)
  }

  const findToken = (value: unknown): string | null => {
    if (!value || typeof value !== "object") return null
    for (const [k, v] of Object.entries(value)) {
      if (/^(access_?token|jwt_?token|token)$/i.test(k) && typeof v === "string" && v.length > 8)
        return v
    }
    return null
  }

  const refreshSide = async (rt: Runtime) => {
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
      stateOut.innerHTML =
        groups.size === 0
          ? `<span class="muted">The mock holds no records yet.</span>`
          : [...groups]
              .map(
                ([name, values]) =>
                  `<details${groups.size < 4 ? " open" : ""}><summary><strong>${escapeHtml(name)}</strong> <span class="muted">${values.length} record${values.length === 1 ? "" : "s"}</span></summary>${highlightJson(values.slice(-20))}</details>`,
              )
              .join("")
    } catch (error) {
      stateOut.textContent = `Snapshot unavailable: ${(error as Error).message}`
    }
    try {
      const res = await rt.fetch(new Request(`${data.origin}/__admin/requests`))
      const journal = (await res.json()) as { requests?: Record<string, unknown>[] }
      const rows = (journal.requests ?? []).slice(-50).reverse()
      journalOut.innerHTML =
        rows.length === 0
          ? `<span class="muted">No requests yet.</span>`
          : rows
              .map(
                (r) =>
                  `<div class="jrow"><span class="method" data-m="${escapeHtml(String(r.method))}">${escapeHtml(String(r.method))}</span><span class="jpath">${escapeHtml(String(r.path))}</span><span class="jstatus" data-ok="${Number(r.status) < 400}">${escapeHtml(String(r.status))}</span><span class="muted">${escapeHtml(String(r.operationId ?? "unmatched"))} · ${escapeHtml(String(r.durationMs))} ms</span></div>`,
              )
              .join("")
    } catch {
      journalOut.innerHTML = `<span class="muted">This mock does not expose a request journal.</span>`
    }
  }

  const run = async () => {
    send.disabled = true
    out.innerHTML = `<span class="muted">Sending…</span>`
    tokenBox.hidden = true
    try {
      const rt = await start()
      const m = method.value
      const hasBody = m !== "GET" && m !== "HEAD" && body.value.trim() !== ""
      const request = new Request(
        `${data.origin}${path.value.startsWith("/") ? "" : "/"}${path.value}`,
        {
          method: m,
          headers: parseHeaders(headers.value),
          ...(hasBody ? { body: body.value } : {}),
        },
      )
      const t0 = performance.now()
      const res = await rt.fetch(request)
      const ms = performance.now() - t0
      const type = res.headers.get("content-type") ?? ""
      const buf = await res.arrayBuffer()
      const ok = res.status < 400
      meta.innerHTML = `<span class="st" data-ok="${ok}">${res.status} ${escapeHtml(res.statusText || REASONS[res.status] || "")}</span><span>${ms.toFixed(1)} ms</span><span>${formatBytes(buf.byteLength)}</span>`
      const headerLines = [...res.headers]
        .map(([k, v]) => `<span class="hk">${escapeHtml(k)}:</span> ${escapeHtml(v)}`)
        .join("\n")
      let bodyHtml: string
      if (/^(audio|image|video)\//.test(type)) {
        const url = URL.createObjectURL(new Blob([buf], { type }))
        bodyHtml = type.startsWith("audio")
          ? `<audio controls src="${url}"></audio>`
          : type.startsWith("image")
            ? `<img alt="Response image" src="${url}">`
            : `<video controls src="${url}"></video>`
      } else {
        const text = new TextDecoder().decode(buf)
        let parsed: unknown
        try {
          parsed = type.includes("json") || /^\s*[[{]/.test(text) ? JSON.parse(text) : undefined
        } catch {}
        if (parsed !== undefined) {
          bodyHtml = highlightJson(parsed)
          collectIds(parsed)
          const found = findToken(parsed)
          if (found) {
            tokenBox.hidden = false
            tokenBox.innerHTML = `<span>This response issued a token.</span> <button type="button" class="chip-sm" data-use-token>Use it as the bearer token</button>`
            tokenBox.dataset.token = found
          }
        } else {
          bodyHtml = text
            ? escapeHtml(text.length > 20000 ? `${text.slice(0, 20000)}\n…` : text)
            : `<span class="muted">(empty body)</span>`
        }
      }
      out.innerHTML = `<details class="rh"><summary>Headers</summary>${headerLines}</details>${bodyHtml}`
      updateFill()
      await refreshSide(rt)
    } catch (error) {
      meta.innerHTML = `<span class="st" data-ok="false">Error</span>`
      out.textContent = `${(error as Error).name}: ${(error as Error).message}`
    } finally {
      send.disabled = false
    }
  }

  $<HTMLFormElement>("[data-pg-form]").addEventListener("submit", (e) => {
    e.preventDefault()
    void run()
  })
  root.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault()
      void run()
    }
  })
  list.addEventListener("click", (e) => {
    const b = (e.target as Element).closest<HTMLButtonElement>("[data-op]")
    if (b?.dataset.op) select(b.dataset.op, true)
  })
  filter.addEventListener("input", () => {
    const q = filter.value.toLowerCase().trim()
    for (const b of list.querySelectorAll<HTMLButtonElement>("[data-op]")) {
      const li = b.parentElement as HTMLElement
      li.hidden =
        q !== "" &&
        !(b.textContent ?? "").toLowerCase().includes(q) &&
        !(b.dataset.op ?? "").toLowerCase().includes(q)
    }
  })
  fill.addEventListener("click", (e) => {
    const b = (e.target as Element).closest<HTMLButtonElement>("[data-fill]")
    if (!b?.dataset.fill) return
    path.value = path.value.replace(/\{[^}]+\}/, encodeURIComponent(b.dataset.fill))
    updateFill()
  })
  path.addEventListener("input", updateFill)
  tokenBox.addEventListener("click", (e) => {
    if (!(e.target as Element).closest("[data-use-token]") || !tokenBox.dataset.token) return
    token = tokenBox.dataset.token
    const lines = headers.value.split("\n").filter((l) => !/^authorization:/i.test(l))
    headers.value = [`authorization: Bearer ${token}`, ...lines].join("\n")
    tokenBox.innerHTML = `<span>Using the issued token for every request on this page.</span>`
  })
  reset.addEventListener("click", async () => {
    const rt = await start()
    await rt.reset("*")
    lastIds = []
    token = null
    updateFill()
    await refreshSide(rt)
    out.innerHTML = `<span class="muted">State reset. The mock is empty again.</span>`
    meta.innerHTML = ""
  })

  for (const group of ["req", "res"] as const) {
    const tabs = [...root.querySelectorAll<HTMLButtonElement>(`[data-${group}-tab]`)]
    const panels = [...root.querySelectorAll<HTMLElement>(`[data-${group}-panel]`)]
    for (const tab of tabs) {
      tab.addEventListener("click", () => {
        const name = tab.getAttribute(`data-${group}-tab`)
        for (const t of tabs) t.setAttribute("aria-selected", String(t === tab))
        for (const p of panels) p.hidden = p.getAttribute(`data-${group}-panel`) !== name
      })
    }
  }

  const requested = new URLSearchParams(location.search).get("op")
  const initial =
    data.operations.find((o) => o.id === requested)?.id ?? data.operation ?? data.operations[0]?.id
  if (initial) {
    select(initial, false, Boolean(requested))
    if (requested) root.scrollIntoView({ block: "start" })
  }

  // Fetch the mock's chunk when someone reaches for the playground, so the first send is quick.
  const warm = () => void loaders[data.service]?.().catch(() => {})
  root.addEventListener("pointerenter", warm, { once: true })
  root.addEventListener("focusin", warm, { once: true })

  for (const b of document.querySelectorAll<HTMLButtonElement>("[data-try-op]")) {
    b.addEventListener("click", () => {
      if (!b.dataset.tryOp) return
      select(b.dataset.tryOp)
      root.scrollIntoView({ behavior: "smooth", block: "start" })
    })
  }
}
