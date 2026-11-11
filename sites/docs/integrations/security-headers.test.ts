import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import {
  allowRuntimeStyles,
  FALLBACK_CSP,
  pageKey,
  pagePolicies,
  SECURITY_HEADERS,
  type StaticHeaders,
  setSecurityHeaders,
} from "../server/headers.ts"

const headers: StaticHeaders = [
  { pathname: "/services/aha", headers: [{ key: "Content-Security-Policy", value: "aha" }] },
  { pathname: "/services", headers: [{ key: "Content-Security-Policy", value: "services" }] },
  { pathname: "/404", headers: [{ key: "Content-Security-Policy", value: "not-found" }] },
]

const response = () => {
  const set = new Map<string, unknown>()
  const res = {
    setHeader(name: string, value: unknown) {
      set.set(name.toLowerCase(), value)
      return res
    },
  }
  return { res, set }
}

describe("security headers", () => {
  test("a page is named the same with or without a slash, index.html or a query", () => {
    for (const url of ["/services", "/services/", "/services/index.html", "/services?q=s3"]) {
      expect(pageKey(url)).toBe("/services")
    }
    expect(pageKey("/")).toBe("/")
    expect(pageKey("/index.html")).toBe("/")
  })

  test("each page gets its own CSP, never a longer path's", () => {
    const { res, set } = response()
    setSecurityHeaders("/services/", res as never, pagePolicies(headers))
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
      expect(set.get(name.toLowerCase())).toBe(value)
    }
    expect(set.get("content-security-policy")).toBe("services")
    // @astrojs/node then sets the CSP it matched by substring; the exact one stays.
    res.setHeader("Content-Security-Policy", "aha")
    expect(set.get("content-security-policy")).toBe("services")
  })

  test("any other path gets the 404 page's CSP, or a deny-all one without it", () => {
    const { res, set } = response()
    setSecurityHeaders("/nope", res as never, pagePolicies(headers))
    expect(set.get("content-security-policy")).toBe("not-found")
    const bare = response()
    setSecurityHeaders("/nope", bare.res as never, new Map())
    expect(bare.set.get("content-security-policy")).toBe(FALLBACK_CSP)
  })
})

test("style-src allows the <style> elements live examples add at runtime; scripts stay hashed", () => {
  const astro =
    "default-src 'self'; script-src 'self' 'sha256-a='; style-src 'self' 'sha256-b=' 'sha256-c='; style-src-attr 'unsafe-inline';"
  expect(allowRuntimeStyles(astro)).toBe(
    "default-src 'self'; script-src 'self' 'sha256-a='; style-src 'self' 'unsafe-inline'; style-src-attr 'unsafe-inline';",
  )
  const policies = pagePolicies([
    { pathname: "/examples/x", headers: [{ key: "Content-Security-Policy", value: astro }] },
  ])
  expect(policies.get("/examples/x")).not.toContain("sha256-b=")
})

const dist = join(import.meta.dir, "../dist")

// `test` depends on `build`: every inline script a page runs must be in that page's CSP, or the
// browser blocks it. An `is:inline` script outside <InlineScript> fails here.
test.skipIf(!existsSync(join(dist, "_headers.json")))(
  "every built page's CSP allows each of its inline scripts",
  () => {
    const policies = pagePolicies(
      JSON.parse(readFileSync(join(dist, "_headers.json"), "utf8")) as StaticHeaders,
    )
    const blocked: string[] = []
    for (const file of new Bun.Glob("**/*.html").scanSync({ cwd: join(dist, "client") })) {
      const csp = policies.get(pageKey(`/${file}`.replace(/(index)?\.html$/, ""))) ?? ""
      const scriptSrc = /script-src([^;]*)/.exec(csp)?.[1] ?? ""
      const html = readFileSync(join(dist, "client", file), "utf8")
      for (const [, code = ""] of html.matchAll(
        /<script(?![^>]*\bsrc=)(?![^>]*type="application\/(?:ld\+)?json")[^>]*>([\s\S]*?)<\/script>/g,
      )) {
        const hash = `sha256-${createHash("sha256").update(code).digest("base64")}`
        if (!scriptSrc.includes(`'${hash}'`)) blocked.push(`${file}: ${code.trim().slice(0, 40)}`)
      }
    }
    expect(blocked).toEqual([])
  },
)
