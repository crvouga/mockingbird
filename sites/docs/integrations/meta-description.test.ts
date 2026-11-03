import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { META_DESCRIPTION_MAX, metaDescription } from "../src/lib/meta.ts"

describe("metaDescription", () => {
  test("keeps short copy as it is", () => {
    expect(metaDescription("Stateful emulator of the Resend API.")).toBe(
      "Stateful emulator of the Resend API.",
    )
  })

  test("renders inline markdown as plain text", () => {
    expect(
      metaDescription(
        "Covers [Emulate](https://emulate.dev/), pinned to `emulate@0.12.1`, **now**.",
      ),
    ).toBe("Covers Emulate, pinned to emulate@0.12.1, now.")
  })

  test("keeps whole sentences that fit", () => {
    const first = `${"a".repeat(100)}.`
    expect(metaDescription(`${first} B${"b".repeat(100)}.`)).toBe(first)
  })

  test("cuts one long sentence at a word, with an ellipsis", () => {
    const out = metaDescription(
      "Stateful emulator of the Stripe API (accounts by key, customers, payments, subscriptions that renew, pause, resume and cancel, invoices, checkout with a hosted page, a hosted customer portal) at API versions 2024-06-20 and 2025-02-24.acacia.",
    )
    expect([...out].length).toBeLessThanOrEqual(META_DESCRIPTION_MAX)
    expect(out).toBe(
      "Stateful emulator of the Stripe API (accounts by key, customers, payments, subscriptions that renew, pause, resume and cancel, invoices, checkout with a hosted…",
    )
  })
})

const client = join(import.meta.dir, "../dist/client")
const decode = (html: string) =>
  html
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")

// `test` depends on `build`, so this reads the pages the build just wrote.
test.skipIf(!existsSync(client))("every built page's meta description fits", () => {
  const long: string[] = []
  for (const file of new Bun.Glob("**/*.html").scanSync({ cwd: client })) {
    const html = readFileSync(join(client, file), "utf8")
    for (const [, content = ""] of html.matchAll(
      /<meta (?:name|property)="(?:description|og:description|twitter:description)" content="([^"]*)"/g,
    )) {
      const text = decode(content)
      if ([...text].length > META_DESCRIPTION_MAX) long.push(`${file} (${[...text].length})`)
    }
  }
  expect(long).toEqual([])
})
