import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { createEmulator as oracle } from "emulate"
import coverage from "../coverage.json" with { type: "json" }
import reviewed from "../reviewed-differences.json" with { type: "json" }
import { scenarios } from "./scenarios.js"
import { shape } from "./shape.js"
import { nativeProviders, target } from "./targets.js"

async function contract(response: Response): Promise<unknown> {
  const contentType = response.headers.get("content-type")?.split(";")[0] ?? null
  const body = await response.arrayBuffer()
  return {
    status: response.status,
    contentType,
    body: body.byteLength
      ? contentType === "application/json"
        ? shape(JSON.parse(new TextDecoder().decode(body)))
        : "non-json"
      : "empty",
  }
}

describe("native vendor APIs against the independent pinned package oracle", () => {
  test("oracle version is pinned", () => {
    const file = join(dirname(fileURLToPath(import.meta.resolve("emulate"))), "../package.json")
    expect(JSON.parse(readFileSync(file, "utf8")).version).toBe("0.12.1")
  })
  for (const name of nativeProviders) {
    test(`${name}: registered vendor routes agree on response structure`, async () => {
      const remote = await oracle({ service: name, port: 0 })
      const local = await target(name, remote.url)
      try {
        const differences: { route: string; actual: unknown; expected: unknown }[] = []
        for (const route of coverage.services[name].routes) {
          const [method, pattern] = route.split(" ")
          if (
            !method ||
            !pattern ||
            pattern === "/" ||
            pattern.startsWith("/_emulate") ||
            pattern.startsWith("/checkout/")
          )
            continue
          const path = pattern
            .replace(/:([\w]+)(?:\{[^}]*\})?/g, "oracle-missing")
            .replaceAll("*", "oracle-missing")
          const url = new URL(path, remote.url)
          const headers = {
            authorization: `Bearer ${name === "stripe" ? "sk_test_oracle" : name === "slack" ? "xoxb-oracle" : "oracle-probe"}`,
            "content-type":
              name === "stripe"
                ? "application/x-www-form-urlencoded"
                : "application/json; charset=utf-8",
          }
          const init = {
            headers,
            method,
            redirect: "manual" as const,
            ...(method === "GET" || method === "HEAD"
              ? {}
              : { body: name === "stripe" ? "" : "{}" }),
          }
          const [actual, expected] = await Promise.all([
            local.fetch(new Request(url, init)),
            fetch(url, init),
          ])
          const a = await contract(actual),
            b = await contract(expected)
          if (JSON.stringify(a) !== JSON.stringify(b))
            differences.push({ route, actual: a, expected: b })
        }

        const known = reviewed as Partial<
          Record<string, Record<string, { reason: string; actual: unknown; expected: unknown }>>
        >
        for (const difference of differences) {
          const accepted = known[name]?.[difference.route]
          expect(accepted, `${name}: unreviewed difference ${difference.route}`).toBeDefined()
          expect(difference.actual).toEqual(accepted?.actual)
          expect(difference.expected).toEqual(accepted?.expected)
        }
        expect(differences.map((row) => row.route).sort()).toEqual(
          Object.keys(known[name] ?? {}).sort(),
        )
      } finally {
        await remote.close()
      }
    }, 60_000)
    test(`${name}: stateful scenario and reset agree on semantic values`, async () => {
      const remote = await oracle({ service: name, port: 0 })
      const local = await target(name, remote.url)
      const requestLocal = (path: string, init?: RequestInit) =>
        local.fetch(new Request(new URL(path, remote.url), { ...init, redirect: "manual" }))
      const requestRemote = (path: string, init?: RequestInit) =>
        fetch(new URL(path, remote.url), { ...init, redirect: "manual" })
      try {
        for (let round = 0; round < 2; round++) {
          const [actual, expected] = await Promise.all([
            scenarios[name](requestLocal),
            scenarios[name](requestRemote),
          ])
          expect(actual).toEqual(expected)
          await local.reset()
          remote.reset()
        }
      } finally {
        await remote.close()
      }
    }, 60_000)
  }
})
