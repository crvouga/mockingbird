import { expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import { createRuntime } from "@crvouga/mockingbird-service"
import { startFleet } from "./src/fleet.js"
import { fleetConfigSchema, validateFleetConfig } from "./src/fleet-schema.js"

test("public schema and standalone validation reject typos/version errors with field paths (#417)", async () => {
  expect(
    JSON.parse(
      await readFile(
        new URL("../../../sites/docs/public/schemas/fleet-v1.json", import.meta.url),
        "utf8",
      ),
    ),
  ).toEqual(fleetConfigSchema)
  expect(validateFleetConfig({ schemaVersion: 1, services: { stripe: { port: 0 } } })).toEqual([])
  expect(
    validateFleetConfig({ services: { stripe: { prot: "http", port: -1 } } }).map((i) => i.path),
  ).toEqual(["$.services.stripe.prot", "$.services.stripe.port"])
  expect(
    validateFleetConfig({ schemaVersion: 99, services: { stripe: {} } })[0]?.message,
  ).toContain("upgrade")
  expect(validateFleetConfig({ services: { stripe: { options: { typo: "bad" } } } })[0]?.path).toBe(
    "$.services.stripe.options.typo",
  )
  expect(
    validateFleetConfig(
      { services: { stripe: { options: { fixture: "ok" } } } },
      { stripe: { fixture: { type: "string", description: "synthetic" } } },
    ),
  ).toEqual([])
})

test("fleet guide configurations validate against the same public schema used by startup (#417)", async () => {
  const guide = await readFile(new URL("../../../docs/FLEETS.md", import.meta.url), "utf8")
  let checked = 0
  for (const match of guide.matchAll(/```json\n([\s\S]*?)```/g)) {
    const example = JSON.parse(match[1] as string) as { services?: unknown; state?: unknown }
    if (!example.services || example.state) continue
    expect(validateFleetConfig(example)).toEqual([])
    checked++
  }
  expect(checked).toBeGreaterThanOrEqual(2)
  let listened = false
  await expect(
    startFleet({ schemaVersion: 99, services: { fixture: { port: 0 } } } as never, {
      load: async () => ({
        name: "fixture",
        defaultPort: 0,
        create: () =>
          createRuntime({
            name: "fixture",
            create: () => ({ fetch: async () => new Response("ok"), reset: async () => {} }),
          }),
        listening: () => {
          listened = true
        },
      }),
    }),
  ).rejects.toThrow("upgrade")
  expect(listened).toBe(false)
})
