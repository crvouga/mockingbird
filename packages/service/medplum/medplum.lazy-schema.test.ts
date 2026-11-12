/**
 * The FHIR definitions are indexed per StructureDefinition on first use (#711): a request
 * parses only the types it touches, and every `@medplum/core` lookup still sees the schema an
 * eager load builds. `@medplum/core`'s schema is process-global, so each scenario runs in a
 * fresh child process and reports back which definitions it indexed (a seam, not a clock).
 */
import { describe, expect, test } from "bun:test"
import { STRUCTURE_DEFINITIONS } from "./src/generated/definitions-data.js"

type Step = { name: string; status: number; body: unknown; indexed: string[] }

/** Run `body` (async statements with `step`, `request` in scope) in a fresh process. */
const runFresh = async (body: string): Promise<Step[]> => {
  const script = `
    import { createRuntime, SUPER_ADMIN_CLIENT_ID, SUPER_ADMIN_CLIENT_SECRET } from "./src/index.js"
    import { indexedStructureDefinitions } from "./src/schema.js"
    const runtime = createRuntime()
    const authorization = "Basic " + btoa(SUPER_ADMIN_CLIENT_ID + ":" + SUPER_ADMIN_CLIENT_SECRET)
    const steps = []
    const request = async (name, method, path, payload) => {
      const response = await runtime.fetch(new Request("http://127.0.0.1/" + path, {
        method,
        headers: { authorization, "content-type": "application/fhir+json" },
        body: payload === undefined ? undefined : JSON.stringify(payload),
      }))
      const json = await response.json()
      steps.push({ name, status: response.status, body: json, indexed: [...indexedStructureDefinitions()] })
      return json
    }
    ${body}
    console.log(JSON.stringify(steps))
  `
  const child = Bun.spawn([process.execPath, "--eval", script], {
    cwd: import.meta.dir,
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (code !== 0) throw new Error(`child exited ${code}: ${stderr}`)
  return JSON.parse(stdout.trim().split("\n").at(-1) as string) as Step[]
}

const step = (steps: Step[], name: string): Step => {
  const found = steps.find((s) => s.name === name)
  if (!found) throw new Error(`no step ${name}`)
  return found
}

describe("lazy FHIR schema indexing (#711)", () => {
  test("the first Patient create indexes Patient and its datatypes, not unrelated types", async () => {
    const steps = await runFresh(`
      await request("create", "POST", "fhir/R4/Patient", {
        resourceType: "Patient",
        name: [{ given: ["Ada"], family: "Lovelace" }],
        telecom: [{ system: "email", value: "ada@example.com" }],
      })
    `)
    const create = step(steps, "create")
    expect(create.status).toBe(201)
    expect(create.indexed).toContain("Patient")
    expect(create.indexed).toContain("HumanName")
    for (const unrelated of ["Observation", "Organization", "Encounter", "Questionnaire", "Bundle"])
      expect(create.indexed).not.toContain(unrelated)
    expect(create.indexed.length).toBeLessThan(STRUCTURE_DEFINITIONS.length / 4)
  }, 30_000)

  test("/metadata lists every resource type and its search parameters without indexing them", async () => {
    const steps = await runFresh(`await request("metadata", "GET", "fhir/R4/metadata")`)
    const metadata = step(steps, "metadata")
    expect(metadata.status).toBe(200)
    const resources = (
      metadata.body as {
        rest: { resource: { type: string; profile: string; searchParam?: { name: string }[] }[] }[]
      }
    ).rest[0]?.resource
    expect(resources?.length).toBeGreaterThan(140)
    const observation = resources?.find((r) => r.type === "Observation")
    expect(observation?.profile).toBe("http://hl7.org/fhir/StructureDefinition/Observation")
    expect(observation?.searchParam?.map((p) => p.name)).toContain("code")
    expect(metadata.indexed).not.toContain("Observation")
    expect(metadata.indexed.length).toBeLessThan(STRUCTURE_DEFINITIONS.length / 4)
  }, 30_000)

  test("cross-type requests index the types they reach and behave as before", async () => {
    const steps = await runFresh(`
      const org = await request("org", "POST", "fhir/R4/Organization", { resourceType: "Organization", name: "Acme" })
      await request("patient", "POST", "fhir/R4/Patient", {
        resourceType: "Patient",
        name: [{ family: "Hopper" }],
        managingOrganization: { reference: "Organization/" + org.id },
      })
      await request("include", "GET", "fhir/R4/Patient?family=Hopper&_include=Patient:organization")
      await request("chained", "GET", "fhir/R4/Patient?organization.name=Acme")
      await request("transaction", "POST", "fhir/R4", {
        resourceType: "Bundle",
        type: "transaction",
        entry: [
          {
            fullUrl: "urn:uuid:4d3b9b8e-6c1a-4c55-9f0e-6f2d3c1b0a01",
            resource: { resourceType: "Patient", name: [{ family: "Bundle" }] },
            request: { method: "POST", url: "Patient" },
          },
          {
            resource: {
              resourceType: "Observation",
              status: "final",
              code: { coding: [{ system: "http://loinc.org", code: "8867-4" }] },
              subject: { reference: "urn:uuid:4d3b9b8e-6c1a-4c55-9f0e-6f2d3c1b0a01" },
              valueQuantity: { value: 60, unit: "/min" },
            },
            request: { method: "POST", url: "Observation" },
          },
        ],
      })
      await request("invalid", "POST", "fhir/R4/Encounter", {
        resourceType: "Encounter",
        status: "finished",
        class: { system: "http://terminology.hl7.org/CodeSystem/v3-ActCode", code: "AMB" },
        participant: [{ period: { start: "not a date" } }],
      })
    `)
    expect(step(steps, "org").status).toBe(201)
    expect(step(steps, "patient").status).toBe(201)

    const include = step(steps, "include")
    expect(include.status).toBe(200)
    const included = (
      include.body as { entry: { resource: { resourceType: string }; search: { mode: string } }[] }
    ).entry
    expect(included.map((e) => [e.resource.resourceType, e.search.mode])).toEqual([
      ["Patient", "match"],
      ["Organization", "include"],
    ])

    const chained = step(steps, "chained")
    expect(chained.status).toBe(200)
    expect((chained.body as { entry?: unknown[] }).entry?.length).toBe(1)

    const transaction = step(steps, "transaction")
    expect(transaction.status).toBe(200)
    const responses = (transaction.body as { entry: { response: { status: string } }[] }).entry
    expect(responses.map((e) => e.response.status)).toEqual(["201", "201"])
    expect(transaction.indexed).toContain("Observation")
    expect(transaction.indexed).toContain("Quantity")

    // A nested datatype (Encounter.participant.period.start) is still validated.
    const invalid = step(steps, "invalid")
    expect(invalid.status).toBe(400)
    expect(JSON.stringify(invalid.body)).toContain("Encounter.participant[0].period.start")
    expect(invalid.indexed).toContain("Period")

    // Every step indexed only what it reached: nothing here touches e.g. Questionnaire.
    expect(steps.at(-1)?.indexed).not.toContain("Questionnaire")
  }, 30_000)

  test("indexing on demand builds the same schema as indexing everything up front", async () => {
    // Fingerprint the whole @medplum/core schema: every data type (key order included) and
    // every resource type's search parameters.
    const fingerprint = `
      import { getAllDataTypes, globalSchema } from "@medplum/core"
      const hasher = new Bun.CryptoHasher("sha256")
      const keys = Object.keys(getAllDataTypes())
      for (const key of keys) {
        hasher.update(key + "=" + JSON.stringify(getAllDataTypes()[key], (k, v) =>
          k === "parentType" ? v?.name : v instanceof Set ? [...v] : v))
      }
      for (const [type, info] of Object.entries(globalSchema.types))
        hasher.update(type + ":" + JSON.stringify(info.searchParams))
      console.log(JSON.stringify({ keys, hash: hasher.digest("hex") }))
    `
    const run = async (setup: string) => {
      const child = Bun.spawn([process.execPath, "--eval", `${setup}\n${fingerprint}`], {
        cwd: import.meta.dir,
        stdout: "pipe",
        stderr: "pipe",
      })
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ])
      if (code !== 0) throw new Error(`child exited ${code}: ${stderr}`)
      return JSON.parse(stdout.trim()) as { keys: string[]; hash: string }
    }
    const lazy = await run(`
      import { ensureSchema } from "./src/schema.js"
      await ensureSchema()
    `)
    // The pre-#711 load: every definition parsed and indexed at once.
    const eager = await run(`
      import { indexSearchParameter, indexStructureDefinitionBundle } from "@medplum/core"
      import { DEFINITIONS_GZIP_BASE64 } from "./src/generated/definitions-data.js"
      const text = new TextDecoder().decode(
        Bun.gunzipSync(Uint8Array.from(atob(DEFINITIONS_GZIP_BASE64), (c) => c.charCodeAt(0))),
      )
      const [searchParameters, ...structureDefinitions] = text.trim().split("\\n").map((line) => JSON.parse(line))
      indexStructureDefinitionBundle(structureDefinitions)
      for (const searchParameter of searchParameters) indexSearchParameter(searchParameter)
    `)
    expect(lazy.keys.length).toBeGreaterThan(STRUCTURE_DEFINITIONS.length)
    expect(lazy.keys).toEqual(eager.keys)
    expect(lazy.hash).toBe(eager.hash)
  }, 30_000)
})
