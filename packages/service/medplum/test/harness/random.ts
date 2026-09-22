/**
 * Random differential walks: fast-check generates programs of FHIR operations — creates,
 * reads, updates, JSON patches, deletes, history reads and searches drawn from a grammar over
 * the data the program created — and each program runs, in a fresh project, against the
 * oracle and the mock. Every exchange is canonicalized and compared; the first divergence
 * fails the run and fast-check shrinks the program to a minimal reproduction.
 */
import fc from "fast-check"
import { ensureSchema } from "../../src/schema.js"
import { Canonicalizer, diff } from "./canonical.js"
import { entryOrderFor, matchCount } from "./order.js"
import { provisionProject, type Target } from "./target.js"

const GIVEN = ["Ada", "Alan", "Grace", "Émile", "Mary-Jane", "Bo", "O'Neil", "Zoë"]
const FAMILY = ["Lovelace", "Turing", "Hopper", "Zola", "Smith-Jones", "Ng", "Van Der Berg"]
const CITIES = ["London", "New York", "Paris", "Tōkyō", "São Paulo"]
const SYSTEMS = ["https://example.org/mrn", "https://example.org/ssn"]
const CODES = [
  { system: "http://loinc.org", code: "8867-4", display: "Heart rate" },
  { system: "http://loinc.org", code: "29463-7", display: "Body weight" },
  { system: "http://snomed.info/sct", code: "38341003", display: "Hypertension" },
]

const dateArb = fc
  .tuple(
    fc.integer({ min: 1900, max: 2030 }),
    fc.integer({ min: 1, max: 12 }),
    fc.integer({ min: 1, max: 28 }),
  )
  .map(([y, m, d]) => `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`)

const instantArb = fc
  .tuple(dateArb, fc.integer({ min: 0, max: 23 }), fc.integer({ min: 0, max: 59 }))
  .map(([date, h, m]) => `${date}T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00Z`)

const maybe = <T>(arb: fc.Arbitrary<T>) => fc.option(arb, { nil: undefined, freq: 3 })

const patientArb = fc.record({
  resourceType: fc.constant("Patient"),
  active: maybe(fc.boolean()),
  gender: maybe(fc.constantFrom("male", "female", "other", "unknown")),
  birthDate: maybe(dateArb),
  name: maybe(
    fc.array(
      fc.record({
        use: maybe(fc.constantFrom("official", "usual", "nickname", "old")),
        given: maybe(fc.array(fc.constantFrom(...GIVEN), { minLength: 1, maxLength: 2 })),
        family: maybe(fc.constantFrom(...FAMILY)),
      }),
      { minLength: 1, maxLength: 2 },
    ),
  ),
  identifier: maybe(
    fc.array(
      fc.record({
        system: maybe(fc.constantFrom(...SYSTEMS)),
        value: fc.constantFrom("A-1", "A-2", "B-1", "b-1"),
      }),
      { minLength: 1, maxLength: 2 },
    ),
  ),
  telecom: maybe(
    fc.array(
      fc.record({
        system: fc.constant("email"),
        value: fc.constantFrom("Ada@Example.org", "x@y.org"),
      }),
      {
        maxLength: 1,
        minLength: 1,
      },
    ),
  ),
  address: maybe(
    fc.array(
      fc.record({ city: fc.constantFrom(...CITIES), country: maybe(fc.constantFrom("UK", "US")) }),
      { minLength: 1, maxLength: 2 },
    ),
  ),
})

type Command =
  | { kind: "createPatient"; resource: Record<string, unknown> }
  | {
      kind: "createObservation"
      patient: number | undefined
      code: number
      status: string
      value: number | undefined
      effective: string | undefined
    }
  | { kind: "read"; target: number }
  | { kind: "readMissing" }
  | { kind: "update"; target: number; resource: Record<string, unknown> }
  | { kind: "patch"; target: number; op: "gender" | "active" | "removeName" | "bad" }
  | { kind: "delete"; target: number }
  | { kind: "history"; target: number }
  | { kind: "searchPatient"; query: string[] }
  | { kind: "searchObservation"; query: (string | { ref: number })[] }

const prefixArb = fc.constantFrom("", "gt", "lt", "ge", "le", "ne", "sa", "eb")

const patientQueryPart = fc.oneof(
  fc
    .tuple(
      fc.constantFrom("name", "family", "given"),
      fc.constantFrom("", ":exact", ":contains"),
      fc.constantFrom(...GIVEN, ...FAMILY, "a", "lo", "ze"),
    )
    .map(([p, m, v]) => `${p}${m}=${encodeURIComponent(v)}`),
  fc
    .tuple(
      fc.constantFrom("", ":not", ":missing"),
      fc.constantFrom("male", "female", "other,unknown", "true", "false"),
    )
    .map(([m, v]) => `gender${m}=${v}`),
  fc.tuple(prefixArb, dateArb).map(([p, d]) => `birthdate=${p}${d}`),
  fc.constantFrom("active=true", "active=false", "active:not=true", "active:missing=true"),
  fc
    .tuple(
      fc.constantFrom("", "https://example.org/mrn|", "|"),
      fc.constantFrom("A-1", "B-1", "b-1", ""),
    )
    .map(([s, v]) => `identifier=${encodeURIComponent(s + v)}`),
  fc.constantFrom(...CITIES).map((c) => `address-city=${encodeURIComponent(c)}`),
  fc.constantFrom("email=ada@example.org", "email:contains=example", "telecom:missing=true"),
  fc.constantFrom(
    "_count=2",
    "_count=0",
    "_offset=1&_count=2",
    "_total=accurate",
    "_summary=count",
  ),
  fc.constantFrom(
    "_sort=birthdate",
    "_sort=-birthdate",
    "_sort=family",
    "_sort=-family",
    "_sort=gender,birthdate",
    "_sort=-_lastUpdated",
  ),
)

const observationQueryPart: fc.Arbitrary<string | { ref: number }> = fc.oneof(
  fc.constantFrom(...CODES).map((c) => `code=${encodeURIComponent(`${c.system}|${c.code}`)}`),
  fc.constantFrom(...CODES).map((c) => `code=${c.code}`),
  fc.constantFrom("status=final", "status=preliminary,amended", "status:not=final"),
  fc.tuple(prefixArb, fc.integer({ min: 0, max: 200 })).map(([p, n]) => `value-quantity=${p}${n}`),
  fc.tuple(prefixArb, instantArb).map(([p, d]) => `date=${p}${encodeURIComponent(d)}`),
  fc.nat({ max: 20 }).map((ref) => ({ ref })),
  fc.constantFrom(...FAMILY).map((f) => `subject:Patient.family=${encodeURIComponent(f)}`),
  fc.constantFrom(
    "_include=Observation:subject",
    "_sort=-date",
    "_sort=value-quantity",
    "subject:missing=true",
  ),
)

const commandArb: fc.Arbitrary<Command> = fc.oneof(
  {
    weight: 4,
    arbitrary: patientArb.map((resource) => ({ kind: "createPatient" as const, resource })),
  },
  {
    weight: 3,
    arbitrary: fc
      .record({
        patient: maybe(fc.nat({ max: 20 })),
        code: fc.nat({ max: CODES.length - 1 }),
        status: fc.constantFrom("final", "preliminary", "amended"),
        value: maybe(fc.integer({ min: 0, max: 200 })),
        effective: maybe(instantArb),
      })
      .map((c) => ({ kind: "createObservation" as const, ...c })),
  },
  {
    weight: 2,
    arbitrary: fc.nat({ max: 20 }).map((target) => ({ kind: "read" as const, target })),
  },
  { weight: 1, arbitrary: fc.constant({ kind: "readMissing" as const }) },
  {
    weight: 2,
    arbitrary: fc
      .tuple(fc.nat({ max: 20 }), patientArb)
      .map(([target, resource]) => ({ kind: "update" as const, target, resource })),
  },
  {
    weight: 2,
    arbitrary: fc
      .tuple(
        fc.nat({ max: 20 }),
        fc.constantFrom("gender", "active", "removeName", "bad") as fc.Arbitrary<
          "gender" | "active" | "removeName" | "bad"
        >,
      )
      .map(([target, op]) => ({ kind: "patch" as const, target, op })),
  },
  {
    weight: 1,
    arbitrary: fc.nat({ max: 20 }).map((target) => ({ kind: "delete" as const, target })),
  },
  {
    weight: 1,
    arbitrary: fc.nat({ max: 20 }).map((target) => ({ kind: "history" as const, target })),
  },
  {
    weight: 5,
    arbitrary: fc
      .array(patientQueryPart, { minLength: 1, maxLength: 3 })
      .map((query) => ({ kind: "searchPatient" as const, query })),
  },
  {
    weight: 3,
    arbitrary: fc
      .array(observationQueryPart, { minLength: 1, maxLength: 3 })
      .map((query) => ({ kind: "searchObservation" as const, query })),
  },
)

type Side = {
  target: Target
  token: string
  canonical: Canonicalizer
  created: { type: string; id: string }[]
}

const pick = <T>(list: T[], index: number): T | undefined =>
  list.length ? list[index % list.length] : undefined

const request = (
  side: Side,
  method: string,
  path: string,
  body?: unknown,
  contentType = "application/fhir+json",
) =>
  side.target.fetch(
    new Request(new URL(path.replace(/^\//, ""), side.target.baseUrl), {
      method,
      headers: {
        authorization: `Bearer ${side.token}`,
        "user-agent": "mockingbird-parity/1.0",
        ...(body !== undefined ? { "content-type": contentType } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    }),
  )

/** Run one command on one side; returns a comparable description and its canonical exchange. */
const execute = async (side: Side, command: Command) => {
  const pickTarget = (n: number) => pick(side.created, n)
  switch (command.kind) {
    case "createPatient": {
      const response = await request(side, "POST", "/fhir/R4/Patient", command.resource)
      const exchange = await side.canonical.exchange(response.clone())
      const body = (await response.json().catch(() => undefined)) as { id?: string } | undefined
      if (response.status === 201 && body?.id) side.created.push({ type: "Patient", id: body.id })
      return { label: "POST Patient", exchange }
    }
    case "createObservation": {
      const patients = side.created.filter((c) => c.type === "Patient")
      const patient = command.patient === undefined ? undefined : pick(patients, command.patient)
      const code = CODES[command.code] as (typeof CODES)[number]
      const resource = {
        resourceType: "Observation",
        status: command.status,
        code: { coding: [code], text: code.display },
        ...(patient ? { subject: { reference: `Patient/${patient.id}` } } : {}),
        ...(command.value !== undefined
          ? { valueQuantity: { value: command.value, unit: "u" } }
          : {}),
        ...(command.effective ? { effectiveDateTime: command.effective } : {}),
      }
      const response = await request(side, "POST", "/fhir/R4/Observation", resource)
      const exchange = await side.canonical.exchange(response.clone())
      const body = (await response.json().catch(() => undefined)) as { id?: string } | undefined
      if (response.status === 201 && body?.id)
        side.created.push({ type: "Observation", id: body.id })
      return { label: "POST Observation", exchange }
    }
    case "read": {
      const target = pickTarget(command.target)
      if (!target) return { label: "read (nothing yet)", exchange: null }
      const response = await request(side, "GET", `/fhir/R4/${target.type}/${target.id}`)
      return { label: `GET ${target.type}/#`, exchange: await side.canonical.exchange(response) }
    }
    case "readMissing": {
      const response = await request(
        side,
        "GET",
        "/fhir/R4/Patient/00000000-0000-4000-8000-00000000abcd",
      )
      return { label: "GET missing", exchange: await side.canonical.exchange(response) }
    }
    case "update": {
      const target = pickTarget(command.target)
      if (!target) return { label: "update (nothing yet)", exchange: null }
      const body =
        target.type === "Patient"
          ? { ...command.resource, id: target.id }
          : {
              resourceType: "Observation",
              id: target.id,
              status: "amended",
              code: { text: "amended" },
            }
      const response = await request(side, "PUT", `/fhir/R4/${target.type}/${target.id}`, body)
      return { label: `PUT ${target.type}/#`, exchange: await side.canonical.exchange(response) }
    }
    case "patch": {
      const target = pickTarget(command.target)
      if (!target) return { label: "patch (nothing yet)", exchange: null }
      const ops = {
        gender: [
          {
            op: "add",
            path: target.type === "Patient" ? "/gender" : "/status",
            value: target.type === "Patient" ? "other" : "final",
          },
        ],
        active: [
          {
            op: "add",
            path: target.type === "Patient" ? "/active" : "/issued",
            value: target.type === "Patient" ? true : "2024-01-01T00:00:00Z",
          },
        ],
        removeName: [{ op: "remove", path: target.type === "Patient" ? "/name" : "/subject" }],
        bad: [{ op: "replace", path: "/nothing", value: 1 }],
      }[command.op]
      const response = await request(
        side,
        "PATCH",
        `/fhir/R4/${target.type}/${target.id}`,
        ops,
        "application/json-patch+json",
      )
      return {
        label: `PATCH ${target.type}/# ${command.op}`,
        exchange: await side.canonical.exchange(response),
      }
    }
    case "delete": {
      const target = pickTarget(command.target)
      if (!target) return { label: "delete (nothing yet)", exchange: null }
      const response = await request(side, "DELETE", `/fhir/R4/${target.type}/${target.id}`)
      return { label: `DELETE ${target.type}/#`, exchange: await side.canonical.exchange(response) }
    }
    case "history": {
      const target = pickTarget(command.target)
      if (!target) return { label: "history (nothing yet)", exchange: null }
      const response = await request(side, "GET", `/fhir/R4/${target.type}/${target.id}/_history`)
      return {
        label: `GET ${target.type}/#/_history`,
        exchange: await side.canonical.exchange(response),
      }
    }
    case "searchPatient": {
      const query = command.query.join("&")
      const response = await request(side, "GET", `/fhir/R4/Patient?${query}`)
      const order = entryOrderFor(
        "GET",
        `/fhir/R4/Patient?${query}`,
        matchCount(
          await response
            .clone()
            .json()
            .catch(() => undefined),
        ),
      )
      return {
        label: `GET Patient?${query}`,
        exchange: await side.canonical.exchange(response, { unorderedEntries: order }),
      }
    }
    case "searchObservation": {
      const patients = side.created.filter((c) => c.type === "Patient")
      const parts = command.query.map((part) => {
        if (typeof part === "string") return part
        const patient = pick(patients, part.ref)
        return `subject=${patient ? `Patient/${patient.id}` : "Patient/00000000-0000-4000-8000-000000000000"}`
      })
      const query = parts.join("&")
      const label = command.query
        .map((p) => (typeof p === "string" ? p : "subject=Patient/#"))
        .join("&")
      const response = await request(side, "GET", `/fhir/R4/Observation?${query}`)
      const order = entryOrderFor(
        "GET",
        `/fhir/R4/Observation?${query}`,
        matchCount(
          await response
            .clone()
            .json()
            .catch(() => undefined),
        ),
      )
      return {
        label: `GET Observation?${label}`,
        exchange: await side.canonical.exchange(response, { unorderedEntries: order }),
      }
    }
  }
}

export type RandomWalkOptions = {
  oracle: Target
  mock: () => Target
  runs: number
  steps: number
  seed: number
  log?: (line: string) => void
}

export const runRandomWalks = async (
  options: RandomWalkOptions,
): Promise<{ ok: true } | { ok: false; report: string }> => {
  const log = options.log ?? (() => {})
  await ensureSchema()
  let walk = 0
  let lastFailure = ""
  // Every walk starts from a population, so searches have something to find, then runs a
  // long program (fast-check's default sizing keeps arrays short).
  const population = fc.tuple(
    fc.array(
      patientArb.map((resource) => ({ kind: "createPatient" as const, resource })),
      { minLength: 3, maxLength: 8 },
    ),
    fc.array(
      fc
        .record({
          patient: fc.nat({ max: 20 }),
          code: fc.nat({ max: CODES.length - 1 }),
          status: fc.constantFrom("final", "preliminary", "amended"),
          value: maybe(fc.integer({ min: 0, max: 200 })),
          effective: maybe(instantArb),
        })
        .map((c) => ({ kind: "createObservation" as const, ...c })),
      { minLength: 1, maxLength: 6 },
    ),
  )
  const program = fc
    .tuple(
      population,
      fc.array(commandArb, {
        minLength: Math.ceil(options.steps / 2),
        maxLength: options.steps,
        size: "max",
      }),
    )
    .map(
      ([[patients, observations], commands]) =>
        [...patients, ...observations, ...commands] as Command[],
    )
  const property = fc.asyncProperty(program, async (commands) => {
    walk++
    const make = async (target: Target): Promise<Side> => {
      const project = await provisionProject(target, `Random walk ${walk}`)
      const canonical = new Canonicalizer(target.baseUrl)
      canonical.name(project.projectId, "project")
      canonical.name(project.clientId, "client")
      return { target, token: project.token, canonical, created: [] }
    }
    const real = await make(options.oracle)
    const mock = await make(options.mock())
    const history: string[] = []
    for (const command of commands) {
      const a = await execute(real, command)
      const b = await execute(mock, command)
      history.push(a.label)
      if (process.env.WALK_DEBUG)
        console.log(
          a.label,
          a.exchange?.status,
          JSON.stringify((a.exchange?.body as { entry?: unknown[] } | undefined)?.entry?.length),
          JSON.stringify((b.exchange?.body as { entry?: unknown[] } | undefined)?.entry?.length),
        )
      const differences = diff(a.exchange, b.exchange)
      if (differences.length > 0) {
        lastFailure = [
          `✗ random walk diverged at step ${history.length}: ${a.label}`,
          ...history.slice(0, -1).map((line, i) => `    ${i + 1}. ${line}`),
          ...differences.slice(0, 15).map((line) => `      ${line}`),
        ].join("\n")
        return false
      }
    }
    return true
  })
  log(`random walks: seed ${options.seed}, ${options.runs} runs, up to ${options.steps} steps`)
  const result = await fc.check(property, {
    seed: options.seed,
    numRuns: options.runs,
    endOnFailure: false,
  })
  if (result.failed) {
    return {
      ok: false,
      report: `${lastFailure}\n\nreplay: bun run parity -- --seed ${options.seed} --runs ${options.runs} --steps ${options.steps}\ncounterexample (shrunk): ${fc.stringify(result.counterexample)}`,
    }
  }
  log(`✓ random walks: ${result.numRuns} runs agreed`)
  return { ok: true }
}
