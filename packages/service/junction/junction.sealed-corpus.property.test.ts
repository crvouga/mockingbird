import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import fc from "fast-check"
import { JunctionAPI, parseSealedCorpus, SEALED_CORPUS_VERSION } from "./src/index.js"

const corpusPath = new URL("./corpus/sandbox-sealed.json", import.meta.url)
const corpus = parseSealedCorpus(JSON.parse(readFileSync(corpusPath, "utf8")))

/** SDK-shaped area/PSC observation keys (`?zip_code=…&radius=100`). */
const sealedKeys = Object.keys(corpus.observations).filter(
  (key) =>
    (key.startsWith("GET /v3/order/area/info?") || key.startsWith("GET /v3/order/psc/info?")) &&
    key.includes("radius=100"),
)
const sealedIndex = fc.integer({ min: 0, max: sealedKeys.length - 1 })

const auth = { "x-vital-api-key": "sk_us_mockingbird" }
const get = (api: JunctionAPI, key: string) => {
  const [method = "GET", target = "/"] = key.split(" ")
  return api.fetch(new Request(`https://junction.test${target}`, { method, headers: auth }))
}
const corpusKey = (index: number): string => {
  const key = sealedKeys[index]
  if (key === undefined) throw new Error("no sealed observation sampled")
  return key
}

describe("sealed corpus fidelity", () => {
  test("the committed corpus is present and versioned", () => {
    expect(corpus.version).toBe(SEALED_CORPUS_VERSION)
    expect(sealedKeys.length).toBeGreaterThan(0)
    expect(corpus.catalog.labTests.length).toBeGreaterThan(0)
    expect(corpus.catalog.labs.length).toBeGreaterThan(0)
  })
  test("two independently installed mocks serve exactly the corpus body", async () => {
    const first = new JunctionAPI()
    const second = new JunctionAPI()
    first.installCorpus(corpus)
    second.installCorpus(corpus)
    await fc.assert(
      fc.asyncProperty(sealedIndex, async (index) => {
        const key = corpusKey(index)
        const expected = corpus.observations[key]?.body
        const [a, b] = await Promise.all([get(first, key), get(second, key)])
        expect(a.status).toBe(corpus.observations[key]?.status ?? 200)
        expect(await a.json()).toEqual(expected)
        expect(await b.json()).toEqual(expected)
      }),
      { numRuns: 25 },
    )
  })

  test("a corpus miss falls back to the synthetic model", async () => {
    const api = new JunctionAPI()
    api.installCorpus(corpus)
    const response = await api.fetch(
      new Request("https://junction.test/v3/order/area/info?zip_code=00001&radius=100", {
        headers: auth,
      }),
    )
    expect(response.status).toBe(200)
    const body = (await response.json()) as Record<string, unknown>
    expect(body).toHaveProperty("central_labs")
  })

  test("reset re-applies the installed corpus", async () => {
    const api = new JunctionAPI()
    api.installCorpus(corpus)
    await api.reset()
    await fc.assert(
      fc.asyncProperty(sealedIndex, async (index) => {
        const key = corpusKey(index)
        const response = await get(api, key)
        expect(response.status).toBe(200)
        expect(await response.json()).toEqual(corpus.observations[key]?.body)
      }),
      { numRuns: 25 },
    )
  })

  test("parseSealedCorpus rejects a wrong version and a non-object", () => {
    expect(() => parseSealedCorpus({ version: 999 })).toThrow(/unsupported sealed corpus version/)
    expect(() => parseSealedCorpus(null)).toThrow(/sealed corpus must be an object/)
    expect(() => parseSealedCorpus([])).toThrow(/sealed corpus must be an object/)
  })
})
