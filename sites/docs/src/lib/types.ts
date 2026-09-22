export type ServiceKind = "http" | "sql" | "node"

export type ServiceStatus = "stable" | "wip"

export interface Operation {
  id: string
  method: string
  path: string
  summary: string | null
  tag: string | null
  supported: boolean
  contentType: string | null
  /** Sample request body derived from the operation's schema, already encoded for `contentType`. */
  body: string
  /** Set when the body cannot be edited as text (binary, multipart, event streams). */
  bodyNote: string | null
  /** Required query parameters, encoded, without the leading `?`. */
  query: string
  headers: Record<string, string>
  /** The sample request, sent to a fresh instance of the mock at build time, answered 2xx/3xx. */
  verified: boolean
}

export interface TocEntry {
  depth: number
  slug: string
  text: string
}

export interface Service {
  name: string
  packageName: string
  displayName: string
  description: string
  keywords: string[]
  category: string
  status: ServiceStatus
  runtime: "portable" | "node" | "bun"
  kind: ServiceKind
  surfaces: {
    /** Exports `createRuntime()`: an in-process `fetch(Request) → Response`. */
    inProcess: boolean
    /** The docs playground can run the real mock in a browser tab. */
    browser: boolean
    /** Ships a Node HTTP server entry (`<package>/server`). */
    server: boolean
    /** The CLI binary name, when the package ships one. */
    cli: string | null
  }
  operations: Operation[]
  opsSupported: number
  opsTotal: number
  playground: {
    /** The operation the playground opens on: verified at build time when any sample is. */
    operation: string | null
    /** How the contract says to authenticate, shown next to the request headers. */
    authHint: string | null
  }
  /** Origin the playground addresses requests to (the contract's first server). */
  origin: string | null
  contract: { title: string | null; upstream: string | null }
  links: { npm: string; source: string; readme: string; support: string | null }
  readme: { markdown: string; html: string; toc: TocEntry[] }
  /** First TypeScript example in the README that only imports the package's main entry. */
  example: { code: string; html: string } | null
  hue: number
}

export interface CategorySummary {
  slug: string
  label: string
  blurb: string
  count: number
}

export interface Catalog {
  repo: string
  services: Service[]
  categories: CategorySummary[]
  totals: {
    services: number
    browser: number
    opsSupported: number
    opsTotal: number
  }
}

/** The per-service slice the search UI and command palette load on every page. */
export interface SearchEntry {
  name: string
  displayName: string
  category: string
  categoryLabel: string
  description: string
  text: string
}
