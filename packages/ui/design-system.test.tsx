import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { IDENTITY } from "../../sites/docs/src/lib/content.ts"
import { MOCKINGBIRD } from "./src/brand.ts"
import { renderDocument, scriptJson } from "./src/document.ts"
import {
  AppShell,
  CenteredCard,
  CodeBlock,
  EmptyState,
  ErrorState,
  KeyValueList,
  LoadingState,
  PageHeader,
  StatusChip,
} from "./src/react/index.ts"
import { renderPage, renderToHtml } from "./src/react/server.tsx"

describe("brand", () => {
  test("matches the docs site's identity", () => {
    expect<string>(MOCKINGBIRD.name).toBe(IDENTITY.name)
    expect<string>(MOCKINGBIRD.icon).toBe(IDENTITY.icon)
    expect<string>(MOCKINGBIRD.tagline).toBe(IDENTITY.tagline)
    expect<string>(MOCKINGBIRD.docs).toBe(IDENTITY.docs)
  })
})

describe("renderDocument", () => {
  test("a complete document with the title, stylesheet and root", () => {
    const html = renderDocument({ title: "Consent <x>", css: "body{}", body: "<p>hi</p>" })
    expect(html.startsWith("<!doctype html>")).toBe(true)
    expect(html).toContain("<title>Consent &lt;x&gt; · Mockingbird</title>")
    expect(html).toContain("<style>body{}</style>")
    expect(html).toContain('<div id="root" data-mockingbird-root><p>hi</p></div>')
    expect(html).toContain('content="light dark"')
    expect(html).not.toContain("data-theme")
  })

  test("pins a theme on <html>", () => {
    const html = renderDocument({ title: "x", css: { href: "/s.css" }, theme: "dark" })
    expect(html).toContain('<html lang="en" data-theme="dark" class="dark">')
    expect(html).toContain('<link rel="stylesheet" href="/s.css">')
  })

  test("starts a bundle with props that cannot close the script element", () => {
    const html = renderDocument({
      title: "x",
      css: "",
      nonce: "abc",
      script: { source: "var A={go(){}}", call: "A.go", props: { text: "</script><b>" } },
    })
    expect(html).toContain('<script nonce="abc">var A={go(){}}')
    expect(html).toContain(
      'A.go(document.getElementById("root"), {"text":"\\u003c/script>\\u003cb>"});',
    )
    expect(html.match(/<\/script>/g)?.length).toBe(1)
  })

  test("rejects a call that is not a global name", () => {
    expect(() =>
      renderDocument({ title: "x", css: "", script: { source: "", call: "alert(1)//" } }),
    ).toThrow()
  })

  test("escapes line separators in embedded JSON", () => {
    expect(scriptJson("a\u2028b")).toBe('"a\\u2028b"')
  })

  test("remembers the visitor's theme only when asked", () => {
    expect(renderDocument({ title: "x", css: "" })).not.toContain("mb:theme")
    expect(renderDocument({ title: "x", css: "", rememberTheme: true })).toContain("mb:theme")
  })
})

describe("server rendering", () => {
  test("every shared component renders on the server", () => {
    const html = renderToHtml(
      <AppShell product="Admin" nav={[{ label: "Home", href: "/", current: true }]}>
        <PageHeader title="Customers" description="Everyone" />
        <StatusChip status="ok">Succeeded</StatusChip>
        <KeyValueList items={[{ label: "ID", value: "cus_1", mono: true }]} />
        <CodeBlock code={'{"a":1}'} language="json" />
        <EmptyState title="Nothing yet" />
        <ErrorState error={new Error("boom")} />
        <LoadingState />
      </AppShell>,
    )
    for (const text of [
      "Mockingbird",
      "Admin",
      "Customers",
      "Succeeded",
      "cus_1",
      "Nothing yet",
      "boom",
    ])
      expect(html).toContain(text)
    expect(html).toContain('aria-current="page"')
    expect(html).toContain("data-mockingbird")
    // The copy button needs JavaScript, so the server leaves it out.
    expect(html).not.toContain('aria-label="Copy"')
  })

  test("a centered form page works without JavaScript", () => {
    const html = renderPage(
      <CenteredCard title="Sign in" product="Google">
        <form method="post" action="/login">
          <button type="submit">Continue</button>
        </form>
      </CenteredCard>,
      { title: "Sign in", css: "" },
    )
    expect(html).toContain('<form action="/login" method="post">')
    expect(html).toMatch(/<h1[^>]*>Sign in<\/h1>/)
    expect(html).toContain("Sign in")
    expect(html).not.toContain("<script")
  })
})

const dist = join(import.meta.dir, "dist")
describe.skipIf(!existsSync(join(dist, "styles.css")))("compiled stylesheet", () => {
  const css = readFileSync(join(dist, "styles.css"), "utf8")
  test("carries the theme, HeroUI's components and the licenses", () => {
    expect(css).toContain("--accent:light-dark(#2563eb,#58a6ff)")
    expect(css).toContain(".card{")
    expect(css).toContain("Bundled third-party notices")
    expect(css).toContain("@heroui/styles@")
  })
  test("emits Preflight once", () => {
    expect(css.match(/tab-size:4/g)?.length).toBe(1)
  })
  test("includes the utilities the shared components use", () => {
    for (const utility of [".min-h-dvh", ".bg-background", ".text-muted", ".font-mono"])
      expect(css).toContain(utility)
  })
})
