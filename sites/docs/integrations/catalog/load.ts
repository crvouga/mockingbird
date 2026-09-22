import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { CATEGORIES, isCategory } from "../../src/lib/categories.ts"
import { EXPECTED_ERROR_SNIPPETS, SQL_SNIPPETS, splitStatements } from "../../src/lib/sql.ts"
import type {
  Catalog,
  Operation,
  Service,
  ServiceKind,
  ServiceStatus,
} from "../../src/lib/types.ts"
import { highlight, renderMarkdown } from "./markdown.ts"
import { authHint, extractOperations, serverOrigin } from "./openapi.ts"

// biome-ignore lint/suspicious/noExplicitAny: package.json and module shapes are checked at runtime.
type Json = any

const STATUSES: readonly ServiceStatus[] = ["stable", "wip"]

// Astro evaluates the config through Vite's module runner, which is closed by the time pages
// load; the built service modules are plain ESM, so import them with Node's own loader.
const nativeImport = new Function("url", "return import(url)") as (url: string) => Promise<Json>

export interface CatalogPaths {
  repoRoot: string
  docsRoot: string
}

/** Every file the catalog reads, so the dev server can reload when one changes. */
export function watchedFiles({ repoRoot }: CatalogPaths): string[] {
  const dir = join(repoRoot, "packages/service")
  return readdirSync(dir).flatMap((name) =>
    ["package.json", "README.md", "dist/index.js"].map((f) => join(dir, name, f)),
  )
}

export async function loadCatalog({ repoRoot, docsRoot }: CatalogPaths): Promise<Catalog> {
  const serviceDir = join(repoRoot, "packages/service")
  const docsPkg = readJson(join(docsRoot, "package.json"))
  const declared = new Set(Object.keys({ ...docsPkg.dependencies, ...docsPkg.devDependencies }))

  const packages = readdirSync(serviceDir)
    .map((name) => ({
      name,
      dir: join(serviceDir, name),
      file: join(serviceDir, name, "package.json"),
    }))
    .filter((p) => existsSync(p.file))
    .map((p) => ({ ...p, pkg: readJson(p.file) }))
    .filter((p) => p.pkg.private !== true && p.pkg.mockingbird?.layer === "service")
  const repo = repositoryUrl(packages[0]?.pkg)

  const names = new Set(packages.map((p) => p.name))
  const problems: string[] = []

  const loaded = await Promise.all(
    packages.map(async ({ name, dir, pkg }): Promise<Service | null> => {
      const where = `packages/service/${name}/package.json`
      const meta = pkg.mockingbird ?? {}
      if (!isCategory(meta.category ?? "")) {
        problems.push(
          `${where}: "mockingbird.category" must be one of ${Object.keys(CATEGORIES).join(", ")} (got ${JSON.stringify(meta.category)})`,
        )
        return null
      }
      if (typeof meta.displayName !== "string" || meta.displayName.trim() === "") {
        problems.push(
          `${where}: "mockingbird.displayName" is required (the vendor's name as people write it)`,
        )
        return null
      }
      const status: ServiceStatus = meta.status ?? "stable"
      if (!STATUSES.includes(status)) {
        problems.push(`${where}: "mockingbird.status" must be one of ${STATUSES.join(", ")}`)
        return null
      }
      if (!declared.has(pkg.name)) {
        problems.push(
          `sites/docs/package.json: add "${pkg.name}": "workspace:*" to devDependencies`,
        )
        return null
      }
      const entry = join(dir, "dist/index.js")
      if (!existsSync(entry)) {
        problems.push(
          `${pkg.name} is not built: run \`bun run build\` (turbo builds it before the docs)`,
        )
        return null
      }

      const mod: Json = await nativeImport(
        `${pathToFileURL(entry).href}?v=${statSync(entry).mtimeMs}`,
      )
      const runtime: Service["runtime"] = meta.runtime ?? "portable"
      const kind: ServiceKind =
        typeof mod.createRuntime === "function" && mod.document
          ? "http"
          : typeof mod.Database === "function"
            ? "sql"
            : "node"
      const document = kind === "http" ? mod.document : null
      const supportedIds: string[] = mod.supportedOperationIds ?? mod.operationIds ?? []
      const playground = meta.playground ?? {}
      const origin = document ? serverOrigin(document) : null
      const operations = document
        ? extractOperations(document, supportedIds, playground.headers)
        : []
      if (document && origin) await verifySamples(mod, origin, operations)
      const defaultOperation = pickDefault(operations, playground.operation)
      if (playground.headers && !operations.some((o) => o.verified)) {
        problems.push(
          `${where}: no sample request succeeds with "mockingbird.playground.headers"; the credentials no longer match what the mock accepts`,
        )
      }
      if (playground.operation) {
        const op = operations.find((o) => o.id === playground.operation)
        if (!op?.verified) {
          problems.push(
            `${where}: "mockingbird.playground.operation" ${JSON.stringify(playground.operation)} ${op ? "does not succeed with its sample request" : "is not an operation in the contract"}`,
          )
        }
      }

      const readmePath = join(dir, "README.md")
      const readmeMarkdown = existsSync(readmePath) ? readFileSync(readmePath, "utf8") : ""
      const readme = await renderMarkdown(readmeMarkdown, {
        dir: `packages/service/${name}`,
        repo,
        services: names,
      })
      const exampleCode = findExample(readmeMarkdown, pkg.name)

      if (kind === "sql") {
        problems.push(...validateSnippets(name, mod))
      }

      const bin = pkg.bin && typeof pkg.bin === "object" ? (Object.keys(pkg.bin)[0] ?? null) : null
      return {
        name,
        packageName: pkg.name,
        displayName: meta.displayName,
        description: pkg.description ?? "",
        keywords: (pkg.keywords ?? []).filter(
          (k: string) => k !== "mockingbird" && k !== "service",
        ),
        category: meta.category,
        status,
        runtime,
        kind,
        surfaces: {
          inProcess: kind === "http",
          browser: runtime === "portable" && kind !== "node",
          server: Boolean(pkg.exports?.["./server"]),
          cli: bin,
        },
        operations,
        opsSupported: operations.filter((o) => o.supported).length,
        opsTotal: operations.length,
        playground: { operation: defaultOperation, authHint: document ? authHint(document) : null },
        origin,
        contract: {
          title: document?.info?.title ?? null,
          upstream: document?.info?.["x-mockingbird-upstream"]?.note ?? null,
        },
        links: {
          npm: `https://www.npmjs.com/package/${pkg.name}`,
          source: `${repo}/tree/main/packages/service/${name}`,
          readme: `${repo}/blob/main/packages/service/${name}/README.md`,
          support: existsSync(join(dir, "SUPPORT.md"))
            ? `${repo}/blob/main/packages/service/${name}/SUPPORT.md`
            : null,
        },
        readme: { markdown: readmeMarkdown, ...readme },
        example: exampleCode
          ? { code: exampleCode, html: await highlight(exampleCode, "ts") }
          : null,
        hue: hue(name),
      }
    }),
  )
  const services = loaded.filter((s): s is Service => s !== null)

  if (problems.length > 0) {
    throw new Error(
      `The docs catalog is out of date with the service packages:\n  - ${problems.join("\n  - ")}`,
    )
  }

  services.sort((a, b) => a.displayName.localeCompare(b.displayName))
  const categories = Object.entries(CATEGORIES)
    .map(([slug, c]) => ({ slug, ...c, count: services.filter((s) => s.category === slug).length }))
    .filter((c) => c.count > 0)

  return {
    repo,
    services,
    categories,
    totals: {
      services: services.length,
      browser: services.filter((s) => s.surfaces.browser).length,
      opsSupported: services.reduce((n, s) => n + s.opsSupported, 0),
      opsTotal: services.reduce((n, s) => n + s.opsTotal, 0),
    },
  }
}

const readJson = (file: string): Json => JSON.parse(readFileSync(file, "utf8"))

function repositoryUrl(pkg: Json): string {
  const url: string = pkg.repository?.url ?? ""
  return url.replace(/^git\+/, "").replace(/\.git$/, "")
}

/** A TypeScript README block that imports only from the package's main entry, so it runs anywhere. */
function findExample(markdown: string, packageName: string): string | null {
  for (const match of markdown.matchAll(/```(?:ts|typescript)\n([\s\S]*?)```/g)) {
    const code = match[1] ?? ""
    const specifiers = [...code.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1])
    if (specifiers.length > 0 && specifiers.every((s) => s === packageName)) return code.trimEnd()
  }
  return null
}

/** Run every console snippet against the real engine, in order, so a broken snippet fails the build. */
function validateSnippets(name: string, mod: Json): string[] {
  const engine = name === "postgres" || name === "sqlite" ? name : null
  if (!engine)
    return [`${name}: no SQL console snippets for this engine (add them in src/lib/sql.ts)`]
  const db = new mod.Database()
  const problems: string[] = []
  for (const snippet of SQL_SNIPPETS[engine]) {
    const statements = splitStatements(snippet.sql)
    statements.forEach((sql, i) => {
      const last = i === statements.length - 1
      try {
        db.query(sql)
        if (last && EXPECTED_ERROR_SNIPPETS.has(snippet.label)) {
          problems.push(`${name} snippet "${snippet.label}" was expected to fail but succeeded`)
        }
      } catch (error) {
        if (!(last && EXPECTED_ERROR_SNIPPETS.has(snippet.label))) {
          problems.push(`${name} snippet "${snippet.label}" failed: ${(error as Error).message}`)
        }
      }
    })
  }
  db.close()
  return problems
}

const VERIFY_TIMEOUT_MS = 2_000

/** Send each supported operation's sample, in contract order, to one fresh instance of the mock. */
async function verifySamples(mod: Json, origin: string, operations: Operation[]): Promise<void> {
  const runtime = mod.createRuntime()
  for (const op of operations) {
    if (!op.supported || op.bodyNote) continue
    const hasBody = op.method !== "GET" && op.method !== "HEAD" && op.body !== ""
    const request = new Request(`${origin}${op.path}${op.query ? `?${op.query}` : ""}`, {
      method: op.method,
      headers: op.headers,
      ...(hasBody ? { body: op.body } : {}),
    })
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const response: Response = await Promise.race([
        runtime.fetch(request),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("timeout")), VERIFY_TIMEOUT_MS)
        }),
      ])
      op.verified = response.status < 400
      await response.body?.cancel()
    } catch {
      op.verified = false
    } finally {
      clearTimeout(timer)
    }
  }
}

/** The declared operation, else a verified one that creates something, else one that reads. */
function pickDefault(operations: Operation[], declared: string | undefined): string | null {
  if (declared) return declared
  const rank = (op: Operation) =>
    (op.verified ? 0 : 10) +
    (op.path.includes("{") ? 4 : 0) +
    (op.method === "POST" ? 0 : op.method === "GET" ? 1 : 2) +
    op.path.split("/").length / 100
  const candidates = operations.filter((o) => o.supported)
  return (
    candidates.reduce<Operation | null>(
      (best, op) => (!best || rank(op) < rank(best) ? op : best),
      null,
    )?.id ?? null
  )
}

/** A stable hue per service for its monogram. */
function hue(name: string): number {
  let h = 0
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) % 360
  return h
}
