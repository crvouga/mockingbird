import { loaders } from "virtual:mockingbird/runtimes"
import { type Snippet, splitStatements } from "../lib/sql.ts"
import { escapeHtml } from "./render.ts"

interface Database {
  query(sql: string): Record<string, unknown>[]
  changes: number
  close(): void
}

const root = document.querySelector<HTMLElement>("[data-sql]")

if (root) {
  const $ = <T extends Element>(sel: string) => root.querySelector<T>(sel) as T
  const service = root.dataset.service ?? ""
  const snippets = JSON.parse($("[data-sql-snippets]").textContent ?? "[]") as Snippet[]
  const input = $<HTMLTextAreaElement>("[data-sql-input]")
  const out = $<HTMLElement>("[data-sql-out]")
  const status = $<HTMLElement>("[data-sql-status]")
  const statusText = $<HTMLElement>("[data-sql-status-text]")
  const reset = $<HTMLButtonElement>("[data-sql-reset]")
  // biome-ignore lint/suspicious/noExplicitAny: the engine module's shape.
  let mod: Promise<any> | undefined
  let db: Database | undefined

  const engine = async () => {
    mod ??= (async () => {
      const load = loaders[service]
      if (!load) throw new Error(`No browser build for ${service}`)
      status.dataset.state = "loading"
      statusText.textContent = "Loading the engine…"
      const t0 = performance.now()
      const m = await load()
      status.dataset.state = "ready"
      statusText.textContent = `Running in this tab · loaded in ${Math.round(performance.now() - t0)} ms · pure TypeScript, no server`
      reset.disabled = false
      return m
    })()
    const m = await mod
    db ??= new m.Database() as Database
    return db
  }

  const cell = (v: unknown) =>
    v === null || v === undefined
      ? `<span class="muted">NULL</span>`
      : escapeHtml(
          typeof v === "object"
            ? JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x))
            : String(v),
        )

  const table = (rows: Record<string, unknown>[]) => {
    const cols = Object.keys(rows[0] ?? {})
    return `<div class="table-wrap"><table class="table"><thead><tr>${cols.map((c) => `<th>${escapeHtml(c)}</th>`).join("")}</tr></thead><tbody>${rows
      .slice(0, 200)
      .map((r) => `<tr>${cols.map((c) => `<td>${cell(r[c])}</td>`).join("")}</tr>`)
      .join("")}</tbody></table></div>`
  }

  const run = async () => {
    const statements = splitStatements(input.value)
    if (statements.length === 0) return
    let d: Database
    try {
      d = await engine()
    } catch (error) {
      out.innerHTML = `<p class="sql-err">${escapeHtml((error as Error).message)}</p>`
      return
    }
    const blocks: string[] = []
    for (const sql of statements) {
      const head = `<code class="sql-stmt">${escapeHtml(sql.length > 120 ? `${sql.slice(0, 117)}…` : sql)}</code>`
      const t0 = performance.now()
      try {
        const rows = d.query(sql)
        const ms = (performance.now() - t0).toFixed(2)
        blocks.push(
          rows.length > 0
            ? `<div class="sql-block">${head}<span class="sql-meta">${rows.length} row${rows.length === 1 ? "" : "s"} · ${ms} ms</span>${table(rows)}</div>`
            : `<div class="sql-block">${head}<span class="sql-meta ok">OK · ${d.changes} row${d.changes === 1 ? "" : "s"} affected · ${ms} ms</span></div>`,
        )
      } catch (error) {
        const e = error as Error & { code?: string }
        blocks.push(
          `<div class="sql-block">${head}<p class="sql-err">${e.code ? `<strong>${escapeHtml(e.code)}</strong> ` : ""}${escapeHtml(e.message)}</p></div>`,
        )
        break
      }
    }
    out.innerHTML = blocks.join("")
  }

  $<HTMLButtonElement>("[data-sql-run]").addEventListener("click", () => void run())
  input.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault()
      void run()
    }
  })
  root.addEventListener("click", (e) => {
    const b = (e.target as Element).closest<HTMLButtonElement>("[data-snippet]")
    const snippet = b ? snippets[Number(b.dataset.snippet)] : undefined
    if (!snippet) return
    input.value = snippet.sql
    input.focus()
  })
  reset.addEventListener("click", () => {
    db?.close()
    db = undefined
    out.innerHTML = `<p class="muted">Fresh database. Start with snippet 1 to create the tables.</p>`
  })
  const warm = () => void loaders[service]?.().catch(() => {})
  root.addEventListener("pointerenter", warm, { once: true })
  root.addEventListener("focusin", warm, { once: true })
}
