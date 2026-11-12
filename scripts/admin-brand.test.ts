import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { brandFor } from "../packages/admin-ui/src/brand.ts"
import { adminBrandDefine, adminBrandFor, logoDataUri, MAX_LOGO_BYTES } from "./admin-brand.ts"

const root = join(import.meta.dir, "..")

test("a service's brand ships with its logo inlined, so the admin chip needs no network", () => {
  const brand = adminBrandFor(join(root, "packages/service/stripe"))
  expect(brand?.vendor).toBe("Stripe")
  expect(brand?.guide).toBe("https://mockingbird.chrisvouga.dev/services/stripe")
  expect(brand?.logo).toMatch(/^data:image\/[a-z+.-]+;base64,/)
  const catalog = JSON.parse(readFileSync(join(root, "sites/docs/src/data/brands.json"), "utf8"))
  const bytes = readFileSync(join(root, "sites/docs/public", catalog.stripe.logo))
  expect(Buffer.from(brand?.logo.split(",")[1] ?? "", "base64").equals(bytes)).toBe(true)
  // The shared client accepts exactly what the build embeds.
  expect(brandFor("stripe", { stripe: brand })?.logo).toBe(brand?.logo)
})

test("every embedded logo passes the client's data URI filter", () => {
  const catalog = JSON.parse(
    readFileSync(join(root, "sites/docs/src/data/brands.json"), "utf8"),
  ) as Record<string, unknown>
  for (const name of Object.keys(catalog)) {
    const brand = adminBrandFor(join(root, "packages/service", name))
    if (!brand?.logo) continue
    expect(brandFor(name, { [name]: brand })?.logo).toBe(brand.logo)
  }
})

test("a package without a brand gets no define; oversized or unknown logos are left out", () => {
  expect(adminBrandFor(join(root, "packages/notifications"))).toBeUndefined()
  expect(adminBrandDefine(join(root, "packages/notifications"))).toEqual({})
  const define = adminBrandDefine(join(root, "packages/service/cognito"))
  expect(JSON.parse(define.__MOCKINGBIRD_ADMIN_BRAND__ ?? "null")?.vendor).toBeString()

  const dir = mkdtempSync(join(tmpdir(), "admin-brand-"))
  try {
    mkdirSync(join(dir, "brands"))
    writeFileSync(join(dir, "brands/big.png"), Buffer.alloc(MAX_LOGO_BYTES + 1))
    writeFileSync(join(dir, "brands/odd.bmp"), Buffer.alloc(8))
    writeFileSync(join(dir, "brands/ok.svg"), "<svg/>")
    expect(logoDataUri("/brands/big.png", dir)).toBe("")
    expect(logoDataUri("/brands/odd.bmp", dir)).toBe("")
    expect(logoDataUri("/brands/missing.svg", dir)).toBe("")
    expect(logoDataUri("/brands/ok.svg", dir)).toBe(
      `data:image/svg+xml;base64,${Buffer.from("<svg/>").toString("base64")}`,
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
