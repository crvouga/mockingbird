/**
 * Self-hosting: configuration, the fail-fast startup report, the `check` command, Vault, and
 * starting and stopping the process. The server runs as a child process against Mockingbird's
 * own PostgreSQL and S3 emulators in server mode; see `specs/support/hosting.ts`.
 */
import { expect } from "@playwright/test"
import { createBdd, type DataTable } from "playwright-bdd"
import { test } from "../support/fixtures.js"
import {
  boot,
  cleanupHosting,
  fatalLine,
  type Hosting,
  hosting,
  jsonLines,
  lastRun,
  listKeys,
  occupyPort,
  PRODUCTION_URL,
  portIsOpen,
  productionEnv,
  queryDatabase,
  reportProblems,
  S3_SECRET,
  secretsIn,
  startPostgresEmulator,
  startS3Emulator,
  startVaultStub,
} from "../support/hosting.js"
import { freePort, PACKAGE_ROOT, serverEnv, startStack } from "../support/stack.js"
import { Given, Then, When } from "./common.steps.js"

const { After } = createBdd(test)

After({ tags: "@hosting" }, async ({ world }) => {
  await cleanupHosting(world)
})

const output = (state: Hosting) => lastRun(state).process.output()

/** The JSON log lines of the latest run. */
const logLines = (state: Hosting) =>
  jsonLines(output(state)).filter((line): line is Record<string, unknown> => line !== undefined)

const rewriteUrl = (state: Hosting, name: string, change: (url: URL) => void) => {
  const url = new URL(state.env[name] ?? "")
  change(url)
  state.env[name] = url.toString()
}

// ---- configurations -----------------------------------------------------------------------

Given(
  "a production deployment with nothing configured but its public address",
  async ({ world }) => {
    hosting(world).env = { PORT: String(await freePort()), PUBLIC_URL: PRODUCTION_URL }
  },
)

Given("a complete production configuration", async ({ world }) => {
  hosting(world).env = await productionEnv(world.stack)
})

Given("a local configuration with only dev login turned on", async ({ world }) => {
  hosting(world).env = { PORT: String(await freePort()), AUTH_DEV_LOGIN: "1" }
})

Given("a local configuration with nothing set", async ({ world }) => {
  hosting(world).env = { PORT: String(await freePort()) }
})

Given(
  "a local configuration with a database, a bucket, dev login and an operator token",
  async ({ world }) => {
    hosting(world).env = serverEnv(world.stack, await freePort())
  },
)

Given("the configuration leaves out {string}", async ({ world }, names: string) => {
  for (const name of names.split(",")) delete hosting(world).env[name.trim()]
})

Given(
  "the configuration sets {string} to {string}",
  async ({ world }, name: string, value: string) => {
    hosting(world).env[name] = value
  },
)

Given("the configuration sets:", async ({ world }, table: DataTable) => {
  for (const [name, value] of table.raw()) if (name) hosting(world).env[name] = value ?? ""
})

Given("another program is already listening on the configured port", async ({ world }) => {
  const state = hosting(world)
  state.cleanups.push(await occupyPort(Number(state.env.PORT)))
  state.notes.set("port occupied", "yes")
})

// ---- the database -------------------------------------------------------------------------

Given(
  "the database is a PostgreSQL server that requires the password {string}",
  async ({ world }, password: string) => {
    const state = hosting(world)
    state.postgres = await startPostgresEmulator({ password })
    state.cleanups.push(state.postgres.stop)
    state.env.DATABASE_URL = state.postgres.url
  },
)

Given("the database is a new, empty PostgreSQL database", async ({ world }) => {
  const state = hosting(world)
  state.postgres = await startPostgresEmulator()
  state.cleanups.push(state.postgres.stop)
  state.env.DATABASE_URL = state.postgres.url
})

Given("DATABASE_URL carries the password {string}", async ({ world }, password: string) => {
  rewriteUrl(hosting(world), "DATABASE_URL", (url) => {
    url.password = password
  })
})

Given("DATABASE_URL names the database {string}", async ({ world }, database: string) => {
  rewriteUrl(hosting(world), "DATABASE_URL", (url) => {
    url.pathname = `/${database}`
  })
})

Given("DATABASE_URL points at a port where nothing is listening", async ({ world }) => {
  const port = String(await freePort())
  rewriteUrl(hosting(world), "DATABASE_URL", (url) => {
    url.port = port
  })
})

Given("DATABASE_URL ends with {string}", async ({ world }, suffix: string) => {
  hosting(world).env.DATABASE_URL += suffix
})

// ---- the object store ---------------------------------------------------------------------

Given("the object store has no bucket named {string}", async ({ world }, bucket: string) => {
  const response = await fetch(`${hosting(world).env.S3_ENDPOINT}/${bucket}`, { method: "HEAD" })
  expect(response.status, `bucket ${bucket} must not exist for this scenario`).toBe(404)
})

Given("S3_ENDPOINT points at a port where nothing is listening", async ({ world }) => {
  hosting(world).env.S3_ENDPOINT = `http://127.0.0.1:${await freePort()}`
})

Given(
  /^the object store answers every request with "(\w+)" \((\d+)\)$/,
  async ({ world }, code: string, status: string) => {
    const state = hosting(world)
    state.s3 = await startS3Emulator()
    state.cleanups.push(state.s3.stop)
    state.env.S3_ENDPOINT = state.s3.url
    await state.s3.failWith(code, Number(status))
  },
)

Given("the object store is a bucket of its own", async ({ world }) => {
  const state = hosting(world)
  state.s3 = await startS3Emulator()
  state.cleanups.push(state.s3.stop)
  state.env.S3_ENDPOINT = state.s3.url
})

Then("the bucket holds no objects under {string}", async ({ world }, prefix: string) => {
  const { env } = hosting(world)
  expect(await listKeys(env.S3_ENDPOINT ?? "", env.S3_BUCKET ?? "", prefix)).toEqual([])
})

// ---- Vault --------------------------------------------------------------------------------

const VAULT_TOKEN = "hvs.vault-token-0a1b2c3d4e5f6a7b"
const VAULT_OPERATOR_TOKEN = "operator-token-kept-in-vault-93b1f6e2a0c4"

async function deploymentBackedByVault(world: Parameters<typeof hosting>[0], path: string) {
  const state = hosting(world)
  const complete = await productionEnv(world.stack)
  state.vault = await startVaultStub()
  state.cleanups.push(state.vault.stop)
  state.vault.tokens.add(VAULT_TOKEN)
  state.vault.documents.set(path, {
    DATABASE_URL: complete.DATABASE_URL,
    S3_ENDPOINT: complete.S3_ENDPOINT,
    S3_REGION: complete.S3_REGION,
    S3_ACCESS_KEY_ID: complete.S3_ACCESS_KEY_ID,
    S3_SECRET_ACCESS_KEY: S3_SECRET,
    S3_BUCKET: complete.S3_BUCKET,
    OPERATOR_TOKEN: VAULT_OPERATOR_TOKEN,
    // Vault documents may hold non-string fields; only strings are variables.
    rotation: { period: "30d" },
  })
  state.secrets.add(S3_SECRET).add(VAULT_OPERATOR_TOKEN)
  state.notes.set("vault path", path)
  // Nothing but the address, the port and where Vault is: every other setting must come from it.
  state.env = {
    PORT: complete.PORT ?? "",
    PUBLIC_URL: PRODUCTION_URL,
    VAULT_ADDR: state.vault.url,
    VAULT_TOKEN,
  }
}

Given("a production deployment that keeps its settings in Vault", async ({ world }) => {
  await deploymentBackedByVault(world, "personal/prd")
})

Given(
  "a production deployment that keeps its settings in Vault at {string}",
  async ({ world }, path: string) => {
    await deploymentBackedByVault(world, path)
  },
)

const vaultDocument = (state: Hosting) => {
  const document = state.vault?.documents.get(state.notes.get("vault path") ?? "")
  if (!document) throw new Error("This scenario has no Vault document")
  return document
}

Given(
  "the Vault document also sets {string} to {string}",
  async ({ world }, name: string, value: string) => {
    vaultDocument(hosting(world))[name] = value
  },
)

Given("the Vault document does not set {string}", async ({ world }, name: string) => {
  delete vaultDocument(hosting(world))[name]
})

Given("Vault does not accept the configured token", async ({ world }) => {
  hosting(world).vault?.tokens.clear()
})

Given("Vault has nothing stored at the path", async ({ world }) => {
  hosting(world).vault?.documents.clear()
})

Given("VAULT_ADDR points at a port where nothing is listening", async ({ world }) => {
  hosting(world).env.VAULT_ADDR = `http://127.0.0.1:${await freePort()}`
})

Given("Vault is sealed for its first {int} reads", async ({ world }, reads: number) => {
  const { vault } = hosting(world)
  if (vault) vault.sealedFor = reads
})

Then("Vault was read once at {string}", async ({ world }, path: string) => {
  expect(hosting(world).vault?.reads.map((read) => read.path)).toEqual([path])
})

Then("Vault was read {int} times", async ({ world }, times: number) => {
  expect(hosting(world).vault?.reads).toHaveLength(times)
})

Then(
  "Vault received the configured token in the {string} header",
  async ({ world }, header: string) => {
    expect(header.toLowerCase()).toBe("x-vault-token")
    expect(hosting(world).vault?.reads.map((read) => read.token)).toEqual([VAULT_TOKEN])
  },
)

Then("the operator token stored in Vault is accepted by the API", async ({ world }) => {
  const response = await fetch(`${lastRun(hosting(world)).url}/api/v1/admin/orgs`, {
    headers: { authorization: `Bearer ${VAULT_OPERATOR_TOKEN}` },
  })
  expect(response.status, await response.text()).toBe(200)
})

// ---- starting and stopping ----------------------------------------------------------------

When("the server process is started", async ({ world }) => {
  await boot(hosting(world))
})

When("the operator runs the check command", async ({ world }) => {
  await boot(hosting(world), ["check"])
})

When("two server processes are started at the same moment", async ({ world }) => {
  const state = hosting(world)
  const second = String(await freePort())
  await Promise.all([boot(state), boot(state, [], { PORT: second })])
})

When("another server process is started against the same database", async ({ world }) => {
  await boot(hosting(world), [], { PORT: String(await freePort()) })
})

When(/^the server process receives (SIGTERM|SIGINT)$/, async ({ world }, signal: string) => {
  const run = lastRun(hosting(world))
  run.code = await run.process.stop(signal as NodeJS.Signals)
})

Then("the server refuses to start", async ({ world }) => {
  const state = hosting(world)
  const run = lastRun(state)
  expect(run.code, run.process.output()).toBe(78)
  expect(run.process.output()).not.toContain('"message":"listening"')
  expect(run.answered, "the port must never answer").toBe(false)
  if (!state.notes.has("port occupied")) expect(await portIsOpen(run.port)).toBe(false)
})

Then("the server is listening", async ({ world }) => {
  const run = lastRun(hosting(world))
  expect(run.code, run.process.output()).toBeUndefined()
  expect((await fetch(`${run.url}/health`)).status).toBe(200)
})

Then("both servers are listening", async ({ world }) => {
  const { runs } = hosting(world)
  expect(runs).toHaveLength(2)
  for (const run of runs) {
    expect(run.code, run.process.output()).toBeUndefined()
    expect((await fetch(`${run.url}/health`)).status).toBe(200)
  }
})

Then(
  "the server answers {string} with status {int}",
  async ({ world }, path: string, status: number) => {
    expect((await fetch(`${lastRun(hosting(world)).url}${path}`)).status).toBe(status)
  },
)

Then(
  "both servers answer {string} with status {int}",
  async ({ world }, path: string, status: number) => {
    for (const run of hosting(world).runs)
      expect((await fetch(`${run.url}${path}`)).status).toBe(status)
  },
)

Then("the server process exits with code {int}", async ({ world }, code: number) => {
  const run = lastRun(hosting(world))
  expect(run.code, run.process.output()).toBe(code)
})

Then("nothing is listening on the configured port any more", async ({ world }) => {
  expect(await portIsOpen(lastRun(hosting(world)).port)).toBe(false)
})

// ---- the check command --------------------------------------------------------------------

Then("the check exits with code {int}", async ({ world }, code: number) => {
  const run = lastRun(hosting(world))
  expect(run.code, run.process.output()).toBe(code)
})

Then(/^the check prints "(.*)"$/, async ({ world }, text: string) => {
  expect(output(hosting(world)).split("\n")).toContain(text)
})

Then(
  "the check prints a {string} JSON line with:",
  async ({ world }, event: string, table: DataTable) => {
    const line = logLines(hosting(world)).find((candidate) => candidate.event === event)
    expect(line, output(hosting(world))).toBeDefined()
    expect(line?.level).toBe("info")
    for (const [key, value] of table.raw()) expect(String(line?.[key ?? ""]), key).toBe(value)
  },
)

Then("the check never listened on the configured port", async ({ world }) => {
  const run = lastRun(hosting(world))
  expect(run.answered).toBe(false)
  expect(run.process.output()).not.toContain('"message":"listening"')
  expect(await portIsOpen(run.port)).toBe(false)
})

// ---- the startup report -------------------------------------------------------------------

Then("the startup report lists {int} problem(s)", async ({ world }, count: number) => {
  const text = output(hosting(world))
  expect(text).toContain(
    `mockingbird-fleet cannot start: ${count} problem${count === 1 ? "" : "s"} to fix`,
  )
  expect(reportProblems(text), text).toHaveLength(count)
})

Then(/^the startup report says "(.*)"$/, async ({ world }, text: string) => {
  // The human-readable report: everything before the machine-readable last line.
  const report = output(hosting(world)).trimEnd().split("\n").slice(0, -1).join("\n")
  expect(report).toContain(text)
})

Then("the startup report tells the operator to set {string}", async ({ world }, name: string) => {
  const lines = reportProblems(output(hosting(world))).flatMap((problem) => problem.lines)
  expect(
    lines.filter((line) => line.startsWith("set: ")),
    output(hosting(world)),
  ).toContainEqual(expect.stringMatching(new RegExp(`^set: ${name}=`)))
})

Then(
  "every problem in the startup report says why it matters, how to fix it and what to set",
  async ({ world }) => {
    const problems = reportProblems(output(hosting(world)))
    expect(problems.length).toBeGreaterThan(0)
    for (const problem of problems) {
      expect(problem.title).not.toBe("")
      for (const label of ["why: ", "fix: "])
        expect(
          problem.lines.filter((line) => line.startsWith(label) && line.length > label.length + 10),
          `${problem.title} needs one "${label.trim()}" line`,
        ).toHaveLength(1)
      expect(
        problem.lines.filter((line) => /^set: [A-Z][A-Z0-9_]*=/.test(line)).length,
        `${problem.title} needs a "set: NAME=example" line`,
      ).toBeGreaterThan(0)
    }
  },
)

Then("the startup output ends with one JSON line listing the same problems", async ({ world }) => {
  const text = output(hosting(world))
  const fatal = fatalLine(text)
  expect(fatal, text).toBeDefined()
  expect(fatal?.level).toBe("fatal")
  expect(fatal?.event).toBe("startup_failed")
  expect(fatal?.problems.map((problem) => problem.what)).toEqual(
    reportProblems(text).map((problem) => problem.title),
  )
  for (const problem of fatal?.problems ?? []) {
    expect(problem.code).toMatch(/^[a-z_]+$/)
    expect(problem.why).not.toBe("")
    expect(problem.fix).not.toBe("")
    expect(Array.isArray(problem.env)).toBe(true)
  }
  expect(text.split("\n").filter((line) => line.startsWith("{"))).toHaveLength(1)
})

Then("no secret from the configuration appears in the startup output", async ({ world }) => {
  const state = hosting(world)
  const secrets = [...secretsIn(state.env), ...state.secrets]
  expect(secrets.length, "the scenario must configure at least one secret").toBeGreaterThan(0)
  for (const run of state.runs)
    for (const secret of secrets) expect(run.process.output()).not.toContain(secret)
})

Then(/^the startup output does not contain "(.*)"$/, async ({ world }, text: string) => {
  // Only meaningful if the scenario really did hand that value to the server.
  const state = hosting(world)
  const given = [...Object.values(state.env), ...state.secrets, state.postgres?.url ?? ""]
  expect(
    given.some((value) => value.includes(text) || decodeURIComponent(value).includes(text)),
  ).toBe(true)
  expect(output(state)).not.toContain(text)
})

Then("the startup output contains no stack trace", async ({ world }) => {
  const text = output(hosting(world))
  expect(text).not.toMatch(/^\s+at .+:\d+:\d+\)?$/m)
  expect(text).not.toContain(PACKAGE_ROOT)
})

// ---- the server log -----------------------------------------------------------------------

Then(
  "the server log has a {string} line with:",
  async ({ world, ownStacks }, message: string, table: DataTable) => {
    const state = hosting(world)
    // A scenario that runs a whole stack (rather than one bare process) reads that server's log.
    const text = state.runs.length > 0 ? output(state) : (ownStacks.at(-1)?.server.output() ?? "")
    const line = jsonLines(text).find((candidate) => candidate?.message === message)
    expect(line, text).toBeDefined()
    for (const [key, value] of table.raw()) expect(String(line?.[key ?? ""]), key).toBe(value)
  },
)

Then(
  "the {string} line gives the public address as localhost on the configured port",
  async ({ world }, message: string) => {
    const state = hosting(world)
    const line = logLines(state).find((candidate) => candidate.message === message)
    expect(state.env.PUBLIC_URL).toBeUndefined()
    expect(line?.public_url).toBe(`http://localhost:${state.env.PORT}`)
    expect(line?.fleet_url).toBe(`http://localhost:${state.env.PORT}`)
  },
)

Then(/^the server log warns "(.*)"$/, async ({ world }, text: string) => {
  const warnings = logLines(hosting(world))
    .filter((line) => line.level === "warn")
    .map((line) => String(line.message))
  expect(
    warnings.some((warning) => warning.includes(text)),
    warnings.join("\n"),
  ).toBe(true)
})

Then("the server log has no warnings", async ({ world }) => {
  const lines = logLines(hosting(world))
  expect(lines.length).toBeGreaterThan(0)
  expect(lines.filter((line) => line.level !== "info")).toEqual([])
})

// ---- the schema ---------------------------------------------------------------------------

const TABLES_QUERY =
  "select table_schema, table_name from information_schema.tables " +
  "where table_schema not in ('pg_catalog', 'information_schema') order by 1, 2"

Then("the database records each schema version exactly once", async ({ world }) => {
  const state = hosting(world)
  const schema = state.env.DATABASE_SCHEMA ?? "mockingbird_fleet"
  const rows = await queryDatabase<{ version: number }>(
    state.env.DATABASE_URL ?? "",
    `select version from ${schema}.schema_migrations order by version`,
  )
  expect(rows.length).toBeGreaterThan(0)
  expect(rows.map((row) => Number(row.version))).toEqual(rows.map((_, index) => index + 1))
  // And the tables were created once: a second creation would have failed the boot.
  const tables = await queryDatabase<{ table_name: string }>(
    state.env.DATABASE_URL ?? "",
    TABLES_QUERY,
  )
  expect(new Set(tables.map((table) => table.table_name)).size).toBe(tables.length)
})

Then(
  "the database has the tables {string} in schema {string}",
  async ({ world }, names: string, schema: string) => {
    const tables = await queryDatabase<{ table_schema: string; table_name: string }>(
      hosting(world).env.DATABASE_URL ?? "",
      TABLES_QUERY,
    )
    const present = tables.filter((t) => t.table_schema === schema).map((t) => t.table_name)
    for (const name of names.split(",")) expect(present).toContain(name.trim())
  },
)

Then("the database has no tables outside schema {string}", async ({ world }, schema: string) => {
  const tables = await queryDatabase<{ table_schema: string; table_name: string }>(
    hosting(world).env.DATABASE_URL ?? "",
    TABLES_QUERY,
  )
  expect(tables.length).toBeGreaterThan(0)
  expect(tables.filter((table) => table.table_schema !== schema)).toEqual([])
})

// ---- shutdown saves state -----------------------------------------------------------------

Given(
  "a server whose hosted emulator has accepted a write it has not saved yet",
  async ({ world, ownStacks }) => {
    const stack = await startStack()
    ownStacks.push(stack)
    world.stack = stack
    const state = hosting(world)
    const org = await world.must<{ id: string }>("Ada", "POST", "/orgs", { name: "Acme" })
    const project = await world.must<{ id: string }>("Ada", "POST", `/orgs/${org.id}/projects`, {
      name: "Staging",
    })
    const fleet = await world.must<{ slug: string }>(
      "Ada",
      "POST",
      `/projects/${project.id}/fleets`,
      {
        name: "Shutdown",
        // A minute between a change and its write, so only the shutdown can be what saves it.
        emulators: {
          resend: { target: "resend", durability: "buffered", flushIntervalMs: 60_000 },
        },
      },
    )
    const sent = await world.emulator(fleet.slug, "resend", "POST", "/emails", {
      headers: { authorization: "Bearer re_vendor_key" },
      body: {
        from: "a@example.test",
        to: "b@example.test",
        subject: "Saved at shutdown",
        text: "still here",
      },
    })
    expect(sent.status, sent.text).toBe(200)
    state.notes.set("fleet", fleet.slug)
    state.notes.set("email", (sent.body as { id: string }).id)
  },
)

When("that server receives SIGTERM", async ({ world }) => {
  hosting(world).notes.set("exit", String(await world.stack.server.stop("SIGTERM")))
})

Then("that server exits with code {int}", async ({ world }, code: number) => {
  expect(hosting(world).notes.get("exit"), world.stack.server.output()).toBe(String(code))
  expect(world.stack.server.output()).not.toContain("state not saved at shutdown")
})

Then("after the server starts again the emulator still has that write", async ({ world }) => {
  const state = hosting(world)
  await world.stack.restart()
  const read = await world.emulator(
    state.notes.get("fleet") ?? "",
    "resend",
    "GET",
    `/emails/${state.notes.get("email")}`,
    { headers: { authorization: "Bearer re_vendor_key" } },
  )
  expect(read.status, read.text).toBe(200)
  expect((read.body as { subject: string }).subject).toBe("Saved at shutdown")
})
