import { describe, expect, test } from "bun:test"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { mock, send } from "./controls.fixture.js"
import {
  ADMIN_CONTROL_PAGES,
  ADMIN_KEY_HEADER,
  assertSnapshotDocument,
  CONTROL_HEADER_REFERENCE,
  CONTROL_HEADERS,
  normalizeBootControls,
  parseControlHeaders,
  STANDARD_ADMIN_ROUTES,
  STANDARD_FAULT_PRESETS,
} from "./src/index.js"

const root = join(import.meta.dir, "..", "..", "..")
const read = (path: string) => readFileSync(join(root, path), "utf8")

/** The guide: a hub that says where each control is, and one page per control. */
const HUB = "docs/ADMIN_CONTROLS.md"
const PAGES = "docs/admin-controls"
const slugOf = (file: string) => file.replace(/\.md$/, "").toLowerCase().replaceAll("_", "-")
const pages = readdirSync(join(root, PAGES))
  .filter((file) => file.endsWith(".md"))
  .sort()
  .map((file) => ({
    file,
    slug: slugOf(file),
    path: `${PAGES}/${file}`,
    text: read(`${PAGES}/${file}`),
  }))
const hub = { file: "ADMIN_CONTROLS.md", slug: "admin-controls", path: HUB, text: read(HUB) }
const documents = [hub, ...pages]
const page = (slug: string) => {
  const found = pages.find((each) => each.slug === slug)
  if (!found) throw new Error(`no page ${slug} in ${PAGES}`)
  return found.text
}

/** The fault rule fields a request body may carry, as `normalizeFault` accepts them. */
const FAULT_FIELDS = [
  "operationId",
  "method",
  "path",
  "pathPrefix",
  "pathPattern",
  "requestHeaders",
  "query",
  "namespace",
  "after",
  "every",
  "count",
  "rate",
  "from",
  "until",
  "status",
  "body",
  "headers",
  "delay",
  "jitter",
  "timeout",
  "drop",
  "truncate",
  "effect",
  "params",
]

/** A heading's anchor, as the docs site and GitHub both derive it. */
const anchorOf = (heading: string) =>
  heading
    .toLowerCase()
    .replace(/[^a-z0-9 _-]/g, "")
    .trim()
    .replaceAll(" ", "-")
const anchors = (markdown: string) =>
  new Set(
    [...markdown.matchAll(/^#{2,4} (.+)$/gm)].map(([, heading]) => anchorOf(heading as string)),
  )

describe("the admin controls guide is easy to find a control in", () => {
  test("there is one page per control, and the docs site lists every one", () => {
    const listed = ADMIN_CONTROL_PAGES.map((each) => each.page)
    expect(pages.map((each) => each.slug).sort()).toEqual([...listed].sort())
    // The docs site orders the pages by this list; a page missing from it would not be shown.
    const content = read("sites/docs/src/lib/content.ts")
    const children = /ADMIN_CONTROLS: \[([\s\S]*?)\]/.exec(content)?.[1] ?? ""
    const ordered = [...children.matchAll(/"([A-Z_]+)"/g)].map(([, name]) => slugOf(name as string))
    expect(ordered).toEqual(listed)
    for (const each of ADMIN_CONTROL_PAGES)
      expect([each.page, page(each.page).startsWith(`# ${each.title}\n`)]).toEqual([
        each.page,
        true,
      ])
  })

  test("the hub links every page, and every page has the same shape", () => {
    for (const each of pages) {
      expect([each.file, hub.text.includes(`](admin-controls/${each.file})`)]).toEqual([
        each.file,
        true,
      ])
      // A one-paragraph summary, search words, then the interface before anything else.
      const [, summary, search, interface_] = each.text.split("\n\n")
      expect([each.file, (summary ?? "").length > 40]).toEqual([each.file, true])
      expect([each.file, search?.startsWith("<!-- search: ")]).toEqual([each.file, true])
      expect([each.file, interface_]).toEqual([
        each.file,
        each.slug === "reference" ? "## Routes" : "## Interface",
      ])
    }
    expect(hub.text).toContain("## Find a control")
  })

  test("the site directory's interface line is defined on that control's page", () => {
    const content = read("sites/docs/src/lib/content.ts")
    const groups = /export const CONTROL_GROUPS = \[([\s\S]*?)\] as const/.exec(content)?.[1] ?? ""
    const rows = [...groups.matchAll(/page: "([A-Z_]+)", call: "([^"]+)"/g)]
    expect(rows.map(([, name]) => slugOf(name as string)).sort()).toEqual(
      pages.map((each) => each.slug).sort(),
    )
    expect(
      rows
        .filter(([, name, call]) => !page(slugOf(name as string)).includes(call as string))
        .map(([, name, call]) => `${name}: ${call}`),
    ).toEqual([])
  })

  test("every link between the pages lands on a page and a heading that exist", () => {
    const broken: string[] = []
    for (const each of documents) {
      for (const [, target] of each.text.matchAll(/\]\(([^)\s]+)\)/g)) {
        if (/^[a-z]+:/.test(target as string)) continue
        const [file, anchor] = (target as string).split("#") as [string, string | undefined]
        const path = file === "" ? each.path : join(dirname(each.path), file)
        if (!existsSync(join(root, path))) broken.push(`${each.file}: ${target}`)
        else if (anchor !== undefined && !anchors(read(path)).has(anchor))
          broken.push(`${each.file}: ${target}`)
      }
    }
    expect(broken).toEqual([])
  })

  test("everything that points into the guide points at a page that exists", () => {
    const slugs = new Set(pages.map((each) => each.slug))
    const pointers = [
      // Each emulator's DISCOVERY.md, the admin UI's views, and the landing page's cards.
      ...[...read("scripts/service-discovery.ts").matchAll(/\$\{GUIDE\}\/([a-z-]+)/g)],
      ...["components.tsx", "controls.tsx", "state.tsx"].flatMap((file) => [
        ...read(`packages/admin-ui/src/${file}`).matchAll(/<ViewTitle page="([a-z-]+)"/g),
      ]),
      ...[...read("sites/docs/src/lib/content.ts").matchAll(/^ {6}page: "([A-Z_]+)",$/gm)],
    ].map(([, name]) => slugOf(name as string))
    expect(pointers.length).toBeGreaterThan(20)
    expect(pointers.filter((slug) => !slugs.has(slug))).toEqual([])
    // The other guides link to a control's page by file.
    const broken: string[] = []
    for (const file of readdirSync(join(root, "docs")).filter((name) => name.endsWith(".md")))
      for (const [, target] of read(`docs/${file}`).matchAll(/\]\((admin-controls\/[^)#\s]+)/g))
        if (!existsSync(join(root, "docs", target as string))) broken.push(`${file}: ${target}`)
    expect(broken).toEqual([])
  })

  test("every shared admin route is in the reference and on its own control's page", () => {
    const reference = page("reference")
    const missing: string[] = []
    for (const route of STANDARD_ADMIN_ROUTES) {
      const [method, path] = route.split(" ") as [string, string]
      const spelled = `\`${method} /__admin${path === "/" ? "" : path}\``
      if (!reference.includes(spelled)) missing.push(`reference: ${spelled}`)
      const owner = ADMIN_CONTROL_PAGES.find((each) =>
        each.routes.includes(`/${path.split("/")[1] ?? ""}`),
      )
      // On its own page a parameter is written the way a caller fills it in: `<id>`.
      const own = spelled.replace(
        /:(\w+)/g,
        (_, name: string) => `<${name === "name" ? "key" : name}>`,
      )
      const text = owner ? page(owner.page) : ""
      if (!text.includes(own) && !text.includes(own.replace("<key>", "<name>")))
        missing.push(`${owner?.page}: ${own}`)
    }
    expect(missing).toEqual([])
  })

  test("every control header is on the headers page with its scope, and on its own page", () => {
    const headers = page("request-headers")
    for (const each of CONTROL_HEADER_REFERENCE) {
      const row = headers.split("\n").find((line) => line.startsWith(`| \`${each.header}\` |`))
      expect([each.header, row?.includes(`| ${each.scope} |`)]).toEqual([each.header, true])
    }
    for (const header of Object.values(CONTROL_HEADERS)) {
      const owner = ADMIN_CONTROL_PAGES.find((each) => each.headers.includes(header))
      expect([header, owner !== undefined && page(owner.page).includes(`\`${header}`)]).toEqual([
        header,
        true,
      ])
      expect(headers).toContain(`\`${header}\``)
      expect(page("reference")).toContain(`\`${header}\``)
    }
    expect(page("reference")).toContain(`\`${ADMIN_KEY_HEADER}\``)
  })

  test("the faults page documents every fault rule field and every standard preset", () => {
    const faults = page("faults")
    expect(FAULT_FIELDS.filter((field) => !faults.includes(`| \`${field}\` |`))).toEqual([])
    expect(
      Object.keys(STANDARD_FAULT_PRESETS).filter((name) => !faults.includes(`| \`${name}\` |`)),
    ).toEqual([])
  })

  test("every runtime method the guide names exists", () => {
    const runtime = mock() as unknown as Record<string, unknown>
    const named = new Set(
      documents.flatMap((each) =>
        [...each.text.matchAll(/\bruntime\.([a-zA-Z]+)/g)].map(([, name]) => name as string),
      ),
    )
    expect(named.size).toBeGreaterThan(15)
    expect([...named].filter((name) => !(name in runtime))).toEqual([])
  })

  test("the landing page and README name only controls that exist", () => {
    const copy = read("sites/docs/src/lib/content.ts")
    const section = copy.slice(
      copy.indexOf("export const ADMIN_CONTROLS"),
      copy.indexOf("export const CONTRACT"),
    )
    const routes = new Set<string>(STANDARD_ADMIN_ROUTES)
    for (const [, method, path] of section.matchAll(
      /(GET|POST|PUT|PATCH|DELETE) (?::\d+)?\/__admin(\/[a-z/]*)?/g,
    )) {
      const route = `${method} ${(path ?? "/").replace(/\/base\//, "/:id/")}`
      expect([route, routes.has(route)]).toEqual([route, true])
    }
    const headers = new Set<string>(Object.values(CONTROL_HEADERS))
    for (const [header] of section.matchAll(/x-mockingbird-[a-z-]+/g))
      expect([header, headers.has(header)]).toEqual([header, true])
    expect(read("README.md")).toContain("## Admin controls")
  })
})

/** The fenced blocks of a markdown file, in order, with whether each directly follows another. */
const fences = (markdown: string) => {
  const found: { language: string; body: string; follows: boolean }[] = []
  let last = -1
  for (const match of markdown.matchAll(/```(\w+)\n([\s\S]*?)```/g)) {
    const between = last < 0 ? "x" : markdown.slice(last, match.index)
    found.push({
      language: match[1] as string,
      body: match[2] as string,
      follows: between.trim() === "",
    })
    last = (match.index as number) + match[0].length
  }
  return found
}

/** The `curl` calls in a shell snippet that reach the admin API, as the requests they make. */
const curls = (shell: string) =>
  shell
    .split(/^curl /m)
    .slice(1)
    .flatMap((call) => {
      const target = /(?:^|\s)'?(?:localhost)?:8787(\/__admin[^\s']*)/.exec(call)
      // `/__admin/ns/<key>/…` is the vendor API under a namespace, not an admin route.
      if (!target || (target[1] as string).startsWith("/__admin/ns/")) return []
      const data = /-d '([^']*)'/.exec(call)
      const headers = Object.fromEntries(
        [...call.matchAll(/-H '([^:']+):\s*([^']*)'/g)].map(([, name, value]) => [name, value]),
      )
      return [
        {
          method: /-X (\w+)/.exec(call)?.[1] ?? "GET",
          path: target[1] as string,
          body: data?.[1],
          headers,
        },
      ]
    })

type Call = ReturnType<typeof curls>[number]

/** The emulator every example in the guide talks to: `stripe`, frozen at midnight on 2030-01-01. */
const example = () =>
  mock({ name: "stripe", adminControls: { clock: { now: "2030-01-01T00:00:00Z", frozen: true } } })

const request = async (runtime: ReturnType<typeof mock>, call: Call) => {
  const response = await runtime.fetch(
    new Request(`http://mock.local${call.path}`, {
      method: call.method,
      headers: call.headers,
      ...(call.body !== undefined ? { body: call.body } : {}),
    }),
  )
  const text = await response.text()
  return { status: response.status, text }
}

const run = async (calls: Call[]) => {
  const runtime = mock()
  const failed: string[] = []
  for (const call of calls) {
    const { status, text } = await request(runtime, call)
    if (status >= 300) failed.push(`${call.method} ${call.path} → ${status} ${text}`)
  }
  return failed
}

describe("the examples in the guide and on the landing page run as written", () => {
  // A `bash` block of admin calls directly followed by a `json` block shows the last call's
  // response. Any other `json` block is a control document or a snapshot document. `jsonc`
  // blocks are illustrations and are not run.
  for (const each of documents) {
    test(`${each.path}: every admin call is accepted and answers what the page shows`, async () => {
      const runtime = example()
      const blocks = fences(each.text)
      let calls = 0
      let shownResponses = 0
      let answer: { call: Call; status: number; text: string } | undefined
      for (const block of blocks) {
        if (block.language === "bash") {
          answer = undefined
          for (const call of curls(block.body)) {
            const { status, text } = await request(runtime, call)
            expect([`${call.method} ${call.path}`, status < 300, text]).toEqual([
              `${call.method} ${call.path}`,
              true,
              text,
            ])
            answer = { call, status, text }
            calls += 1
          }
          continue
        }
        if (block.language !== "json") {
          answer = undefined
          continue
        }
        const shown = JSON.parse(block.body) as Record<string, unknown>
        if (block.follows && answer !== undefined) {
          const call = `${answer.call.method} ${answer.call.path}`
          expect({ call, response: JSON.parse(answer.text) }).toMatchObject({
            call,
            response: shown,
          })
          shownResponses += 1
        } else if ("format" in shown) {
          assertSnapshotDocument(shown)
          mock({ adminControls: { snapshot: shown as never } })
        } else {
          normalizeBootControls(shown)
          mock({ adminControls: shown as never })
        }
        answer = undefined
      }
      // A page about the admin API shows at least one call and what it answers.
      if (each.slug !== "boot" && each.slug !== "request-headers")
        expect([each.path, calls > 0, shownResponses > 0 || each === hub]).toEqual([
          each.path,
          true,
          true,
        ])
    })
  }

  test("the landing page's three carriers each do what they show", async () => {
    const copy = read("sites/docs/src/lib/content.ts")
    const section = copy.slice(
      copy.indexOf("export const ADMIN_CONTROLS"),
      copy.indexOf("export const CONTRACT"),
    )

    // At boot: the object passed as `adminControls`.
    const boot = /adminControls: (\{[\s\S]*?\n {2}\}),\n\}\)/.exec(section)?.[1]
    expect(boot).toBeDefined()
    const adminControls = new Function(`return ${boot}`)() as Record<string, unknown>
    normalizeBootControls(adminControls)
    expect(mock({ adminControls: adminControls as never }).controls()).toMatchObject({
      clock: { iso: "2030-01-01T00:00:00.000Z", frozen: true },
      latency: { delayMs: 40 },
      faults: [{ id: "rate_limited" }],
    })

    // Over /__admin: the curl calls, with the line continuations the page shows.
    const shell = /code: `(curl[\s\S]*?)`,/.exec(section)?.[1]?.replaceAll("\\\\\n", "\\\n")
    const calls = curls(shell ?? "")
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      "POST /__admin/snapshots",
      "POST /__admin/clock",
      "POST /__admin/faults",
      "POST /__admin/snapshots/base/restore",
    ])
    expect(await run(calls)).toEqual([])

    // In a request header: the three headers, on a request that then answers 503.
    const http = /code: `(POST \/v1\/charges[\s\S]*?)`,/.exec(section)?.[1] ?? ""
    const headers = Object.fromEntries(
      http
        .split("\n")
        .slice(1)
        .map((line) => [
          line.slice(0, line.indexOf(":")),
          line.slice(line.indexOf(":") + 1).trim(),
        ]),
    )
    expect(parseControlHeaders(new Headers(headers))).toEqual({
      time: Date.parse("2030-01-01T00:00:00Z"),
      fault: { status: 503, delay: "2s" },
    })
    const runtime = mock()
    const answer = await send(runtime, "POST", "/v1/notes", { body: { text: "a" }, headers })
    expect([answer.status, answer.headers.get("x-mockingbird")]).toEqual([
      503,
      expect.stringContaining("ns=worker-3"),
    ])
    expect(runtime.controls("worker-3").clock.frozen).toBe(true)
  })
})
