/** Optional real-browser gate, using super.engineering's documented browser CLI. */
import { mkdir, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { root } from "./engines.ts"

type BrowserReport = {
  status?: string
  error?: string
  url: string
  runId: string
  compactPages?: { pageCount: number; imageBytes: number; backingBytes: number }
  recovery: string[]
  results: { name: string; medianMs?: number; p95Ms?: number; totalMs?: number }[]
}

async function sc(args: string[]): Promise<unknown> {
  const child = Bun.spawn(["sc", ...args], { stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (code !== 0) throw new Error(`sc ${args.slice(0, 2).join(" ")} failed: ${stderr || stdout}`)
  return args.includes("--json") ? (JSON.parse(stdout) as unknown) : stdout
}

function validate(report: BrowserReport): void {
  if (report.status !== "passed") throw new Error(`Browser benchmark failed: ${report.error}`)
  if (
    report.compactPages?.pageCount !== 64 ||
    report.compactPages.imageBytes !== 1024 * 1024 ||
    report.compactPages.backingBytes !== 1024 * 1024
  )
    throw new Error("Browser IndexedDB cloned oversized page buffers")
  for (const engine of ["sqlite", "postgres"])
    for (const backend of ["indexedDB", "localStorage"]) {
      if (!report.recovery.includes(`${engine}/${backend}: passed`))
        throw new Error(`Missing recovery check: ${engine}/${backend}`)
      for (const metric of ["unchanged-flush", "100-updates-and-save"]) {
        const value = report.results.find(
          (result) => result.name === `${engine}/${backend}/${metric}`,
        )
        if (!value || !Number.isFinite(value.medianMs) || !Number.isFinite(value.p95Ms))
          throw new Error(`Missing browser timing: ${engine}/${backend}/${metric}`)
      }
    }
}

// Act verbs can require a workspace grant. Fail and surface the CLI's reason; do not bypass it.
await sc(["instructions", "browser"])
const server = Bun.spawn(
  [process.execPath, join(root, "packages/service/sqlite/benchmarks/durability-browser.ts")],
  {
    cwd: root,
    stdout: "pipe",
    stderr: "inherit",
  },
)
try {
  const reader = server.stdout.getReader()
  let startup = ""
  let url: string | undefined
  while (!url) {
    const chunk = await reader.read()
    if (chunk.done) throw new Error(`Benchmark server stopped before opening: ${startup}`)
    startup += new TextDecoder().decode(chunk.value)
    url = /Browser benchmark: (http:\/\/127\.0\.0\.1:\d+\/)/.exec(startup)?.[1]
  }
  reader.releaseLock()
  const tabs = (await sc(["browser", "tab", "list", "--json"])) as {
    response: { tabs: { id: string; url: string; title: string }[] }
  }
  const existing = tabs.response.tabs.find(
    (tab) =>
      tab.title === "Mockingbird browser durability benchmark" &&
      /^http:\/\/127\.0\.0\.1:\d+\/$/.test(tab.url),
  )
  await sc(["browser", "open", url, ...(existing ? ["--tab", existing.id] : []), "--json"])
  const opened = (await sc(["browser", "tab", "list", "--json"])) as typeof tabs
  const tab = opened.response.tabs.find((candidate) => candidate.url === url)
  if (!tab) throw new Error("Cannot locate the benchmark browser tab")

  async function completed(previousRun?: string): Promise<BrowserReport> {
    const deadline = Date.now() + 120_000
    while (Date.now() < deadline) {
      let result: { response: { value: BrowserReport | null } }
      try {
        result = (await sc([
          "browser",
          "eval",
          '(() => { try { return JSON.parse(document.querySelector("#result").textContent) } catch { return null } })()',
          "--tab",
          tab?.id ?? "",
          "--json",
        ])) as typeof result
      } catch (error) {
        if (!String(error).includes('"code":"browser_no_tab"')) throw error
        const current = (await sc(["browser", "tab", "list", "--json"])) as {
          response: { tabs: { id: string }[] }
        }
        // Navigation can retire an eval context while the same tab remains open.
        // If the user actually closed it, stop instead of recreating their tab.
        if (!current.response.tabs.some((candidate) => candidate.id === tab?.id)) throw error
        await new Promise((resolve) => setTimeout(resolve, 500))
        continue
      }
      const report = result.response.value
      if (
        report &&
        report.url === url &&
        typeof report.runId === "string" &&
        report.runId !== previousRun &&
        report.status
      ) {
        validate(report)
        return report
      }
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
    throw new Error("Browser performance test timed out")
  }
  const first = await completed()
  console.log("Browser runtime and storage recovery: passed")
  await sc(["browser", "reload", "--tab", tab.id, "--json"])
  const reloaded = await completed(first.runId)
  for (const prior of first.recovery.filter((entry) => entry.includes("/prior-page:"))) {
    const [key, value] = prior.split(": ")
    const expected = (Number(value) || 0) + 1
    if (!reloaded.recovery.includes(`${key}: ${expected}`))
      throw new Error(`Browser reload lost persisted state: ${key}`)
  }
  const directory = resolve(".performance")
  await mkdir(directory, { recursive: true })
  await writeFile(
    join(directory, "browser.json"),
    `${JSON.stringify({ first, reloaded }, null, 2)}\n`,
  )
  console.log(`Browser reload recovery: passed; saved ${join(directory, "browser.json")}`)
} finally {
  server.kill()
  await server.exited
}
