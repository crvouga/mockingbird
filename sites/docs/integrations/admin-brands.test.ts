import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { adminBrands, DOCS_ORIGIN } from "../src/lib/admin-brands.ts"
import type { Brand } from "../src/lib/types.ts"

const brand = (over: Partial<Brand> = {}): Brand => ({
  vendor: "Stripe",
  website: "https://stripe.com",
  docs: "https://docs.stripe.com/api",
  description: "Payments.",
  color: "#635bff",
  logo: "/brands/stripe.svg",
  ...over,
})

test("admin brands are absolute and carry the website, vendor docs, and our guide", () => {
  const record = adminBrands(
    [
      { name: "stripe", brand: brand() },
      {
        name: "aha",
        brand: brand({
          vendor: "mobileAHA",
          website: "https://www.mobileaha.com",
          docs: null,
          description: null,
          color: null,
          logo: "/brands/aha.png",
        }),
      },
    ],
    DOCS_ORIGIN,
  )
  expect(Object.keys(record)).toEqual(["aha", "stripe"])
  expect(record.stripe).toEqual({
    vendor: "Stripe",
    website: "https://stripe.com",
    docs: "https://docs.stripe.com/api",
    guide: `${DOCS_ORIGIN}/services/stripe`,
    logo: `${DOCS_ORIGIN}/brands/stripe.svg`,
    color: "#635bff",
    description: "Payments.",
  })
  expect(record.aha?.docs).toBeNull()
  expect(record.aha?.logo).toBe(`${DOCS_ORIGIN}/brands/aha.png`)
  expect(record.aha?.guide).toBe(`${DOCS_ORIGIN}/services/aha`)
})

test("the admin shell reads its brand from the emulator, never this origin, and names no vendor site", () => {
  const shell = readFileSync(
    join(import.meta.dir, "../../../packages/service/core/src/admin-ui.ts"),
    "utf8",
  )
  const client = readFileSync(
    join(import.meta.dir, "../../../packages/service/core/src/admin-client.ts"),
    "utf8",
  )
  // The record is embedded at build time (scripts/admin-brand.ts) and served by the emulator.
  expect(shell).toContain("ADMIN_BRANDS_PATH")
  expect(shell).not.toContain(`${DOCS_ORIGIN}/brands.json`)
  expect(`${shell}\n${client}`).not.toContain("https://stripe.com")
  expect(`${shell}\n${client}`).not.toContain("https://docs.stripe.com")
})
