/**
 * The load manifest (`parts.json`): what the shell reads to load each app's part, and each
 * backend's, on first use. Its pins are the content-addressed part pins of `./parts.js` (the same
 * part a deploy shares across previews under `parts/<app>/<pin>/`); this file adds what the tab
 * needs on top: the entry to import, the gzip size, the backends and the runtime pin. Also the
 * size budgets the build enforces and the event stream that feeds part updates to an open tab in
 * the dev loop.
 *
 * Portable: Fetch, Streams and CompressionStream only.
 */

/** The load manifest's file name next to the shell. */
export const PREVIEW_LOAD_MANIFEST = "parts.json"

/**
 * One app's entry in the load manifest. Its entry lives in the part's content-addressed directory
 * (`./parts/<app>/<pin>/…`), so it is immutable and cached for good.
 */
export type PreviewLoadPart = {
  /** Relative to the page: an ES module (inline apps) or an HTML document (iframe apps). */
  entry: string
  /** The part's content pin (`createPreviewPart`): changes exactly when the part's bytes change. */
  pin: string
  /** Compressed (gzip) size of the entry and the chunks only it loads. */
  bytes: number
  /** The backends and emulators the app calls. */
  backends?: string[]
  /** Load at idle priority once the first app is open. */
  prefetch?: boolean
}

/** The load manifest (`parts.json`). The deploy manifest is `PreviewPartsManifest`. */
export type PreviewLoadManifest = {
  version: 1
  /** Content pin of the shared runtime (the shell, the worker host, the bridge). */
  runtime: string
  /** Compressed size of what every visit loads before any app: the shell. */
  shellBytes?: number
  parts: Record<string, PreviewLoadPart>
  /** Backend code the worker host imports on a backend's first request or on `replace`. */
  backends?: Record<string, { entry: string; pin: string; bytes: number }>
}

const isPart = (value: unknown): value is { entry: string; pin: string; bytes: number } => {
  const part = value as Partial<PreviewLoadPart> | null
  return (
    !!part &&
    typeof part.entry === "string" &&
    typeof part.pin === "string" &&
    typeof part.bytes === "number" &&
    Number.isFinite(part.bytes) &&
    part.bytes >= 0
  )
}

/** Checks a parsed `parts.json`; throws naming the first malformed field. */
export function parsePreviewLoadManifest(value: unknown): PreviewLoadManifest {
  const manifest = value as Partial<PreviewLoadManifest> | null
  if (manifest?.version !== 1) throw new Error("parts.json: version must be 1")
  if (typeof manifest.runtime !== "string" || manifest.runtime === "")
    throw new Error("parts.json: runtime pin is required")
  if (!manifest.parts || typeof manifest.parts !== "object")
    throw new Error("parts.json: parts is required")
  for (const [id, part] of Object.entries(manifest.parts))
    if (!isPart(part)) throw new Error(`parts.json: part ${id} needs entry, pin and bytes`)
  for (const [id, part] of Object.entries(manifest.backends ?? {}))
    if (!isPart(part)) throw new Error(`parts.json: backend ${id} needs entry, pin and bytes`)
  return manifest as PreviewLoadManifest
}

/** Gzip size of `bytes`, the measure budgets use. */
export async function gzipSize(bytes: Uint8Array | string): Promise<number> {
  const data = typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new CompressionStream("gzip"))
  let size = 0
  const reader = stream.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) return size
    size += value.byteLength
  }
}

/** Compressed-size limits, in bytes. */
export type PreviewPartBudgets = {
  /** The shell's initial payload. */
  shell?: number
  /** Every part, unless `parts` names it. */
  part?: number
  /** Per-part overrides. */
  parts?: Record<string, number>
}

/** A part (or the shell) over its compressed-size budget; thrown by `checkPartBudgets`. */
export class PreviewPartBudgetError extends Error {
  readonly code = "preview_part_over_budget"
  readonly over: { name: string; bytes: number; budget: number }[]
  constructor(over: { name: string; bytes: number; budget: number }[], table: string) {
    super(
      `Over the size budget: ${over
        .map(({ name, bytes, budget }) => `${name} is ${kib(bytes)} gzip, budget ${kib(budget)}`)
        .join("; ")}\n${table}`,
    )
    this.name = "PreviewPartBudgetError"
    this.over = over
  }
}

const kib = (bytes: number) => `${(bytes / 1024).toFixed(1)} KiB`

/** The size table the build prints: each part, its compressed size and its budget. */
export function formatPartSizes(
  manifest: PreviewLoadManifest,
  budgets: PreviewPartBudgets = {},
): string {
  const rows: [string, string, string, string][] = [["part", "gzip", "budget", ""]]
  const add = (name: string, bytes: number, budget: number | undefined) =>
    rows.push([
      name,
      kib(bytes),
      budget === undefined ? "-" : kib(budget),
      budget !== undefined && bytes > budget ? "OVER" : "",
    ])
  if (manifest.shellBytes !== undefined) add("(shell)", manifest.shellBytes, budgets.shell)
  for (const [id, part] of Object.entries(manifest.parts))
    add(id, part.bytes, budgets.parts?.[id] ?? budgets.part)
  for (const [id, part] of Object.entries(manifest.backends ?? {}))
    add(`backend:${id}`, part.bytes, budgets.parts?.[`backend:${id}`] ?? budgets.part)
  const widths = rows[0]?.map((_, column) =>
    Math.max(...rows.map((row) => row[column]?.length ?? 0)),
  )
  return rows
    .map((row) =>
      row
        .map((cell, column) =>
          column === 0 ? cell.padEnd(widths?.[column] ?? 0) : cell.padStart(widths?.[column] ?? 0),
        )
        .join("  ")
        .trimEnd(),
    )
    .join("\n")
}

/** Throws `PreviewPartBudgetError` naming every part over its budget, with the size table. */
export function checkPartBudgets(manifest: PreviewLoadManifest, budgets: PreviewPartBudgets): void {
  const over: { name: string; bytes: number; budget: number }[] = []
  if (
    budgets.shell !== undefined &&
    manifest.shellBytes !== undefined &&
    manifest.shellBytes > budgets.shell
  )
    over.push({ name: "shell", bytes: manifest.shellBytes, budget: budgets.shell })
  for (const [id, part] of Object.entries(manifest.parts)) {
    const budget = budgets.parts?.[id] ?? budgets.part
    if (budget !== undefined && part.bytes > budget)
      over.push({ name: id, bytes: part.bytes, budget })
  }
  for (const [id, part] of Object.entries(manifest.backends ?? {})) {
    const name = `backend:${id}`
    const budget = budgets.parts?.[name] ?? budgets.part
    if (budget !== undefined && part.bytes > budget) over.push({ name, bytes: part.bytes, budget })
  }
  if (over.length > 0) throw new PreviewPartBudgetError(over, formatPartSizes(manifest, budgets))
}

/**
 * Server-Sent Events carrying each new load manifest (the dev loop's `watchPreviewParts`, or any
 * other source): `event: parts`, `data: <manifest>`. The tab follows it with `followPartUpdates`
 * and hands each manifest to `mountSystem(...).applyManifest`.
 */
export function partUpdatesResponse(
  source: {
    manifest(): PreviewLoadManifest | undefined
    subscribe(listener: (manifest: PreviewLoadManifest) => void): () => void
  },
  signal?: AbortSignal,
): Response {
  const encoder = new TextEncoder()
  let stop: (() => void) | undefined
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (manifest: PreviewLoadManifest) => {
        try {
          controller.enqueue(encoder.encode(`event: parts\ndata: ${JSON.stringify(manifest)}\n\n`))
        } catch {
          stop?.()
        }
      }
      const current = source.manifest()
      if (current) send(current)
      stop = source.subscribe(send)
      signal?.addEventListener(
        "abort",
        () => {
          stop?.()
          try {
            controller.close()
          } catch {
            /* Already closed. */
          }
        },
        { once: true },
      )
    },
    cancel() {
      stop?.()
    },
  })
  return new Response(body, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-store",
      connection: "keep-alive",
    },
  })
}

/**
 * The tab's side of `partUpdatesResponse`: calls `apply` with each manifest the stream sends.
 * Returns a disposer. `EventSource` reconnects by itself.
 */
export function followPartUpdates(
  url: string,
  apply: (manifest: PreviewLoadManifest) => undefined | Promise<unknown>,
  options: { EventSource?: new (url: string) => EventSource } = {},
): () => void {
  const Source = options.EventSource ?? globalThis.EventSource
  if (!Source) throw new Error("followPartUpdates needs EventSource")
  const source = new Source(url)
  let chain: Promise<unknown> = Promise.resolve()
  const onParts = (event: MessageEvent<string>) => {
    let manifest: PreviewLoadManifest
    try {
      manifest = parsePreviewLoadManifest(JSON.parse(event.data))
    } catch {
      return
    }
    // Apply in order: a newer manifest waits for the previous swap to settle.
    chain = chain.then(() => apply(manifest)).catch(() => {})
  }
  source.addEventListener("parts", onParts as EventListener)
  return () => {
    source.removeEventListener("parts", onParts as EventListener)
    source.close()
  }
}
