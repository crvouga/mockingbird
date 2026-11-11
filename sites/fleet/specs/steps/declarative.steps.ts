/**
 * Steps for declarative configuration: a `mockingbird.yaml` in someone's repository, applying
 * and planning it against Fleet Cloud, the changes that are reported, and what the organization
 * looks like afterwards. Managed organizations and exporting are in
 * `declarative-managed.steps.ts`; the CLI and local fleets are in `declarative-cli.steps.ts`;
 * helpers are in `specs/support/declarative.ts`.
 *
 * A feature writes `<acme>` in a file where it means a slug, and `acme` everywhere else.
 */
import { expect } from "@playwright/test"
import { createBdd, type DataTable } from "playwright-bdd"
import {
  ACTOR,
  type ApplyOptions,
  actor,
  changesOf,
  cleanup,
  editDeclaration,
  fill,
  fleetNow,
  listed,
  orgNamed,
  orgNow,
  PERSON,
  type ProjectView,
  plain,
  sendFile,
  state,
  theFile,
  writeDeclaration,
} from "../support/declarative.js"
import { test } from "../support/fixtures.js"
import { allEmails, type FleetView, fleetOf, RESEND_KEY, storedState } from "../support/fleets.js"
import type { World } from "../support/world.js"
import { Given, Then, When } from "./common.steps.js"

const { After } = createBdd(test)

// Any scenario may hold a mockingbird.yaml (the dashboard's do too); this is a no-op otherwise.
After(async ({ world }) => {
  await cleanup(world)
})

const step = (pattern: string) => new RegExp(`^${pattern}$`)

// ---- the file in the repository ------------------------------------------------------------

Given(
  step(`${PERSON}'s repository holds this mockingbird\\.yaml:`),
  async ({ world }, person: string, yaml: string) => {
    await world.person(actor(world, person))
    writeDeclaration(world, yaml)
  },
)

Given(
  step(`${PERSON} has applied this mockingbird\\.yaml:`),
  async ({ world }, person: string, yaml: string) => {
    const who = actor(world, person)
    const reply = await sendFile(world, who, writeDeclaration(world, yaml))
    expect(reply.status, reply.text).toBe(200)
  },
)

When(step(`${ACTOR} changes the file to:`), async ({ world }, words: string, yaml: string) => {
  actor(world, words)
  writeDeclaration(world, yaml)
})

When(
  step(`${ACTOR} changes "(.+?)" to "(.*)" in the file`),
  async ({ world }, words: string, from: string, to: string) => {
    actor(world, words)
    editDeclaration(world, from, to)
  },
)

When(
  step(`${ACTOR} adds under "(.*)" in the file:`),
  async ({ world }, words: string, anchor: string, lines: string) => {
    actor(world, words)
    const line = theFile(world)
      .split("\n")
      .find((entry) => entry.trim() === fill(world, anchor))
    if (line === undefined) throw new Error(`The file has no line "${anchor}":\n${theFile(world)}`)
    // The added lines sit one level beneath the line they are added under.
    const indent = `${/^\s*/.exec(line)?.[0] ?? ""}  `
    const added = fill(world, lines)
      .split("\n")
      .map((entry) => `${indent}${entry}`)
      .join("\n")
    writeDeclaration(world, theFile(world).replace(`${line}\n`, `${line}\n${added}\n`))
  },
)

When(
  step(`${ACTOR} removes the line "(.*)" from the file`),
  async ({ world }, words: string, text: string) => {
    actor(world, words)
    const lines = theFile(world).split("\n")
    const index = lines.findIndex((entry) => entry.trim() === fill(world, text))
    if (index < 0) throw new Error(`The file has no line "${text}":\n${theFile(world)}`)
    lines.splice(index, 1)
    writeDeclaration(world, lines.join("\n"))
  },
)

// ---- applying and planning -----------------------------------------------------------------

const optionsFrom = (verb: string, prune?: string, json?: string): ApplyOptions => ({
  dryRun: verb.startsWith("plan"),
  prune: Boolean(prune),
  json: Boolean(json),
})

When(
  step(`${ACTOR} (applies|plans) it(?: again)?( with prune)?( as JSON)?`),
  async ({ world }, words: string, verb: string, prune?: string, json?: string) => {
    await sendFile(world, actor(world, words), theFile(world), optionsFrom(verb, prune, json))
  },
)

Given(
  step(`${ACTOR} has applied it( with prune)?`),
  async ({ world }, words: string, prune?: string) => {
    const reply = await sendFile(world, actor(world, words), theFile(world), {
      prune: Boolean(prune),
    })
    expect(reply.status, reply.text).toBe(200)
  },
)

When(
  step(`${ACTOR} applies a copy of the file that declares the organization "([^"]*)" instead`),
  async ({ world }, words: string, org: string) => {
    const yaml = theFile(world).replace(/^organization: .*$/m, `organization: ${world.slug(org)}`)
    await sendFile(world, actor(world, words), yaml)
  },
)

When(
  step(`${ACTOR} applies this mockingbird\\.yaml of (?:her|his) own:`),
  async ({ world }, words: string, yaml: string) => {
    // Sent as it is, without becoming the file in the scenario's repository.
    await sendFile(world, actor(world, words), fill(world, yaml))
  },
)

When(step(`${ACTOR} applies a file that is not valid YAML`), async ({ world }, words: string) => {
  await sendFile(world, actor(world, words), "version: 1\n  organization: [")
})

// ---- what is reported ----------------------------------------------------------------------

Then("the changes reported are:", async ({ world }, table: DataTable) => {
  const expected = table.hashes().map((row) => ({
    action: row.change,
    kind: row.kind,
    name: row.name,
    detail: row.detail ?? "",
  }))
  expect(changesOf(world, world.last)).toEqual(expected)
})

Then("the only change reported is:", async ({ world }, table: DataTable) => {
  const [action, kind, name, detail] = table.raw()[0] ?? []
  expect(changesOf(world, world.last)).toEqual([{ action, kind, name, detail: detail ?? "" }])
})

Then("nothing is reported to change", async ({ world }) => {
  expect(world.last?.status, world.last?.text).toBe(200)
  expect(changesOf(world, world.last)).toEqual([])
})

Then(
  /^the file is reported as (applied|planned, not applied)$/,
  async ({ world }, outcome: string) => {
    expect(world.last?.status, world.last?.text).toBe(200)
    expect((world.last?.body as { applied?: boolean } | undefined)?.applied).toBe(
      outcome === "applied",
    )
  },
)

/** Nothing changed: planning the file that was last applied still finds nothing to do. */
const stillMatches = async (world: World) => {
  const { applied } = state(world)
  if (!applied) throw new Error("No file has been applied in this scenario")
  const last = world.last
  const reply = await sendFile(world, applied.by, applied.yaml, { dryRun: true })
  expect(reply.status, reply.text).toBe(200)
  expect(changesOf(world, reply)).toEqual([])
  world.last = last
}

Then("Fleet Cloud still matches the file that was applied", async ({ world }) => {
  await stillMatches(world)
})

Then("the refusal lists what would be deleted:", async ({ world }, table: DataTable) => {
  expect(world.last?.status, world.last?.text).toBe(409)
  expect(world.errorCode).toBe("prune_required")
  const message = plain(world, world.errorMessage ?? "")
  const listedThings = /would delete (.*?)\. Declare them/.exec(message)?.[1]?.split(", ")
  expect(listedThings, message).toEqual(table.raw().map(([kind, name]) => `${kind} ${name}`))
  expect(message).toContain("apply with prune=true to delete them")
})

// ---- refusals ------------------------------------------------------------------------------

Then(
  "the file is refused as invalid, naming every problem:",
  async ({ world }, table: DataTable) => {
    expect(world.last?.status, world.last?.text).toBe(400)
    expect(world.errorCode).toBe("invalid_request")
    const details = (world.last?.body as { error?: { details?: string[] } } | undefined)?.error
      ?.details
    const expected = table.raw().map(([path, problem]) => `${path}: ${problem}`)
    expect((details ?? []).map((detail) => plain(world, detail))).toEqual(expected)
    // The message leads with the first problem, for a caller that shows only the message.
    expect(plain(world, world.errorMessage ?? "")).toBe(
      `mockingbird.yaml is invalid: ${expected[0]}`,
    )
  },
)

Then(
  /^the file is refused as invalid at "(.*?)", saying "(.*)"$/,
  async ({ world }, path: string, problem: string) => {
    expect(world.last?.status, world.last?.text).toBe(400)
    expect(world.errorCode).toBe("invalid_request")
    // Problems found in the file itself come as a list; one found against Fleet Cloud's
    // catalog is the message.
    const details = (world.last?.body as { error?: { details?: string[] } } | undefined)?.error
      ?.details
    const problems = (details ?? [world.errorMessage ?? ""]).map((entry) => plain(world, entry))
    expect(
      problems.filter((entry) => entry.includes(path) && entry.includes(problem)),
      problems.join("\n"),
    ).toHaveLength(1)
  },
)

Then(/^the refusal says "(.*)"$/, async ({ world }, text: string) => {
  expect(plain(world, world.errorMessage ?? world.last?.text ?? "")).toContain(text)
})

// ---- the organization afterwards -----------------------------------------------------------

Then(
  step(`${PERSON} is the owner of the organization "([^"]*)"`),
  async ({ world }, person: string, org: string) => {
    expect((await orgNow(world, person, org)).role).toBe("owner")
  },
)

Then(
  "the organization {string} is called {string}",
  async ({ world }, org: string, name: string) => {
    const { owner } = await ownerAnd(world, org)
    expect((await orgNow(world, owner, org)).name).toBe(name)
  },
)

/** Someone who can read an organization: whoever the scenario's fleets or last apply belong to. */
async function ownerAnd(world: World, org: string) {
  const known = orgNamed(world, org)
  for (const [name, credential] of world.people) {
    if (credential.kind === "anonymous") continue
    const last = world.last
    const reply = await world.api(name, "GET", `/orgs/${known.id}`)
    world.last = last
    if (reply.status === 200) return { owner: name, id: known.id }
  }
  throw new Error(`Nobody in this scenario can read the organization "${org}"`)
}

Then(
  /^the organization "([^"]*)" is managed by the file (.+) applied$/,
  async ({ world }, org: string, by: string) => {
    const { owner } = await ownerAnd(world, org)
    const { managed } = await orgNow(world, owner, org)
    const key = /^the key "(.+)"$/.exec(by)?.[1]
    expect(managed, "the organization is not managed").not.toBeNull()
    expect(managed?.appliedBy).toBe(key ? `API key ${key}` : world.email(by))
    expect(Number.isNaN(Date.parse(managed?.appliedAt ?? ""))).toBe(false)
  },
)

Then("the organization {string} is configured by hand", async ({ world }, org: string) => {
  const { owner } = await ownerAnd(world, org)
  expect((await orgNow(world, owner, org)).managed).toBeNull()
})

Then(
  "the organization {string} has exactly these projects and fleets:",
  async ({ world }, org: string, table: DataTable) => {
    const { owner, id } = await ownerAnd(world, org)
    const last = world.last
    const projects = await world.must<{ data: ProjectView[] }>(owner, "GET", `/orgs/${id}/projects`)
    const actual = []
    for (const project of projects.data) {
      const fleets = await world.must<{ data: FleetView[] }>(
        owner,
        "GET",
        `/projects/${project.id}/fleets`,
      )
      actual.push({
        project: plain(world, project.slug),
        name: project.name,
        fleets: fleets.data
          .map((fleet) => plain(world, fleet.slug))
          .sort()
          .join(", "),
      })
    }
    world.last = last
    const byProject = (a: { project: string }, b: { project: string }) =>
      a.project.localeCompare(b.project)
    expect(actual.sort(byProject)).toEqual(
      table
        .hashes()
        .map((row) => ({
          project: row.project ?? "",
          name: row.name ?? "",
          fleets: row.fleets ?? "",
        }))
        .sort(byProject),
    )
  },
)

Then("the organization {string} has no projects", async ({ world }, org: string) => {
  const { owner, id } = await ownerAnd(world, org)
  const last = world.last
  const projects = await world.must<{ data: unknown[] }>(owner, "GET", `/orgs/${id}/projects`)
  world.last = last
  expect(projects.data).toEqual([])
})

// ---- fleets and emulators afterwards -------------------------------------------------------

Then(/^the fleet "([^"]*)" runs (.+)$/, async ({ world }, name: string, words: string) => {
  const fleet = await fleetNow(world, name)
  expect(Object.keys(fleet.emulators).sort()).toEqual(listed(words).sort())
})

Then("the fleet {string} is configured as:", async ({ world }, name: string, table: DataTable) => {
  const fleet = await fleetNow(world, name)
  const project = [...world.things.entries()].find(([, thing]) => thing.id === fleet.projectId)
  const actual: Record<string, string> = {
    name: fleet.name,
    project: project?.[0] ?? fleet.projectId,
    access: fleet.access,
    "requests per minute": String(fleet.requestsPerMinute ?? "the organization's ceiling"),
    url: plain(world, fleet.url),
  }
  for (const [key, value] of table.raw()) expect(actual[key as string], key).toBe(value)
})

Then("the emulators of {string} are:", async ({ world }, name: string, table: DataTable) => {
  const fleet = await fleetNow(world, name)
  const emulators = fleet.emulators as Record<string, Record<string, unknown>>
  const columns = table.raw()[0] ?? []
  const actual = Object.entries(emulators).map(([emulator, spec]) =>
    Object.fromEntries(
      columns.map((column) => [
        column,
        column === "name"
          ? emulator
          : column === "settings"
            ? JSON.stringify(spec.settings ?? {})
            : String(spec[column] ?? ""),
      ]),
    ),
  )
  const byName = (a: Record<string, string>, b: Record<string, string>) =>
    (a.name ?? "").localeCompare(b.name ?? "")
  expect(actual.sort(byName)).toEqual(table.hashes().sort(byName))
})

Then(
  "Fleet Cloud serves nothing as {string} in the fleet {string}",
  async ({ world }, emulator: string, name: string) => {
    const reply = await world.emulator(world.slug(name), emulator, "GET", "/")
    expect(reply.status, reply.text).toBe(404)
  },
)

Then("nothing answers at the URL of the fleet {string}", async ({ world }, name: string) => {
  const reply = await world.emulator(world.slug(name), "resend", "GET", "/emails")
  expect(reply.status, reply.text).toBe(404)
  expect(world.errorMessage).toBe("Fleet not found")
})

Then(
  "the {string} emulator of {string} kept nothing from before",
  async ({ world }, emulator: string, name: string) => {
    const fleet = fleetOf(world, name)
    const sent = allEmails(world).filter(
      (email) => email.fleet === name && email.emulator === emulator,
    )
    expect(sent.length, "the scenario sent nothing through it before").toBeGreaterThan(0)
    // Neither what it serves nor what is stored for it still knows the emails it held.
    const stored = (await storedState(world, fleet, emulator))?.text ?? ""
    for (const email of sent) {
      expect(stored).not.toContain(email.id)
      const reply = await world.emulator(fleet.slug, emulator, "GET", `/emails/${email.id}`, {
        headers: RESEND_KEY,
      })
      expect(reply.status, reply.text).not.toBe(200)
    }
  },
)
