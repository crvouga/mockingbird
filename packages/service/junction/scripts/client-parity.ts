import { VitalClient } from "@tryvital/vital-node"
import { JunctionAPI } from "../src/index.js"

const apiKey = process.env.JUNCTION_API_KEY ?? "sk_us_mockingbird"
const baseUrl = process.env.JUNCTION_MOCK_BASE_URL ?? "https://junction.mockingbird.local"

const withMockFetch = async <T>(api: JunctionAPI, run: (client: VitalClient) => Promise<T>) => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (input, init) => {
    const request = input instanceof Request ? new Request(input, init) : new Request(input, init)
    return api.fetch(request)
  }
  try {
    return await run(new VitalClient({ apiKey, environment: baseUrl }))
  } finally {
    globalThis.fetch = originalFetch
  }
}

const normalize = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(normalize)
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([key]) => !["userId", "user_id", "createdOn", "created_on"].includes(key))
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, normalize(entry)]),
    )
  }
  return value
}

const main = async () => {
  const mock = new JunctionAPI({ now: () => 1_700_000_000_000 })
  const mockResult = await withMockFetch(mock, async (client) => {
    const created = await client.user.create({ clientUserId: "sdk-client-1" })
    const labTest = await client.labTests.getById("c533549c-1e62-4afe-9a0e-0567a9b2bcc2")
    return { created, labTest }
  })
  process.stdout.write(`${JSON.stringify(normalize(mockResult))}\n`)
}

if (import.meta.main) await main()

export { normalize, withMockFetch }
