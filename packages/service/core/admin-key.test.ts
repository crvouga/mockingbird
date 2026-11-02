import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { ADMIN_KEY_HEADER, createRuntime } from "./src/index.js"

const runtime = () =>
  createRuntime({
    name: "notes",
    adminKey: "secret",
    create: () => ({ fetch: async () => new Response("ok"), reset: async () => {} }),
  })

const state = (headers: Record<string, string>) =>
  runtime().fetch(new Request("http://mock.local/__admin/state", { headers }))

describe("admin key", () => {
  test("only the exact key opens the admin API", async () => {
    expect((await state({})).status).toBe(401)
    expect((await state({ [ADMIN_KEY_HEADER]: "" })).status).toBe(401)
    expect((await state({ [ADMIN_KEY_HEADER]: "secreT" })).status).toBe(401)
    expect((await state({ [ADMIN_KEY_HEADER]: "secret2" })).status).toBe(401)
    expect((await state({ [ADMIN_KEY_HEADER]: "secret" })).status).toBe(200)
  })

  // Timing cannot be asserted reliably in a unit test, so this pins the call sites instead:
  // a plain `!==` returns as soon as one character differs, which lets a caller recover the
  // key one character at a time from response times.
  test("every admin key check uses the constant-time compare", () => {
    for (const file of ["control.ts", "runtime.ts"]) {
      const source = readFileSync(new URL(`./src/${file}`, import.meta.url), "utf8")
      expect({ file, plain: source.match(/get\(ADMIN_KEY_HEADER\)\s*[!=]==/g) }).toEqual({
        file,
        plain: null,
      })
      expect(source).toContain("hasAdminKey(")
    }
  })
})
