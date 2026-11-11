/**
 * Steps that run the published `mockingbird-fleet` CLI as a real process in the scenario's
 * repository: `plan` and `apply` against Fleet Cloud, and `serve`, which runs a declared fleet
 * on the person's own machine.
 */
import { connect } from "node:net"
import { expect } from "@playwright/test"
import {
  ACTOR,
  actor,
  type CliRun,
  chosenPort,
  lastRun,
  listed,
  localFleet,
  localService,
  PERSON,
  plain,
  queryPostgres,
  remember,
  runCli,
  serveLocally,
  tokenOf,
  type Vendor,
  vendorCall,
  writeRepositoryFile,
} from "../support/declarative.js"
import { fleetOf } from "../support/fleets.js"
import type { World } from "../support/world.js"
import { Given, Then, When } from "./common.steps.js"

const step = (pattern: string) => new RegExp(`^${pattern}$`)

Given(
  step(`${PERSON}'s repository holds this fleet configuration "([^"]*)":`),
  async ({ world }, person: string, name: string, content: string) => {
    actor(world, person)
    writeRepositoryFile(world, name, content)
  },
)

/**
 * After the CLI changed Fleet Cloud, learn the organization it applied to, so later steps can
 * ask after its fleets by name.
 */
async function learn(world: World, who: string, run: CliRun) {
  if (run.code !== 0) return
  const { data } = await world.must<{ data: { id: string }[] }>(who, "GET", "/orgs")
  for (const org of data) await remember(world, who, org.id)
}

/**
 * `mockingbird-fleet plan|apply …` with the environment a person would have exported:
 * MOCKINGBIRD_FLEET_URL and MOCKINGBIRD_FLEET_TOKEN, unless the step leaves one out or keeps
 * the credential under another name.
 */
When(
  step(
    `${ACTOR} runs "mockingbird-fleet ((?:plan|apply)[^"]*)"( without MOCKINGBIRD_FLEET_URL| without MOCKINGBIRD_FLEET_TOKEN| with (?:her|his|its) credential in [A-Z_]+)?`,
  ),
  async ({ world }, words: string, command: string, variant?: string) => {
    const who = actor(world, words)
    const variable = / credential in ([A-Z_]+)$/.exec(variant ?? "")?.[1]
    const env: Record<string, string> = {
      MOCKINGBIRD_FLEET_URL: world.url,
      [variable ?? "MOCKINGBIRD_FLEET_TOKEN"]: await tokenOf(world, who),
    }
    if (variant?.startsWith(" without ")) delete env[variant.slice(" without ".length)]
    await learn(world, who, runCli(world, command.replace("<fleet-cloud>", world.url), env))
  },
)

When(
  step(`${ACTOR} runs "mockingbird-fleet (plan|apply)" while Fleet Cloud cannot be reached`),
  async ({ world }, words: string, command: string) => {
    runCli(world, command, {
      // Nothing listens on the discard port.
      MOCKINGBIRD_FLEET_URL: "http://127.0.0.1:9",
      MOCKINGBIRD_FLEET_TOKEN: await tokenOf(world, actor(world, words)),
    })
  },
)

When(
  step(`${ACTOR} runs "mockingbird-fleet (serve[^"]*)"`),
  async ({ world }, words: string, command: string) => {
    actor(world, words)
    await serveLocally(world, command)
  },
)

// ---- what the CLI printed ------------------------------------------------------------------

const lines = (text: string) =>
  text
    .split("\n")
    .map((line) => line.trimEnd())
    .filter(Boolean)

Then("it prints:", async ({ world }, expected: string) => {
  const run = lastRun(world)
  expect(lines(plain(world, run.stdout)), run.stderr).toEqual(lines(expected))
})

Then("it exits with code {int}", async ({ world }, code: number) => {
  const run = lastRun(world)
  expect(run.code, `${run.stdout}\n${run.stderr}`).toBe(code)
})

Then("it fails, saying:", async ({ world }, expected: string) => {
  const run = lastRun(world)
  expect(run.code, `${run.stdout}\n${run.stderr}`).toBe(1)
  expect(lines(plain(world, run.stderr))).toEqual(lines(expected))
})

Then("its error output is a message, not a stack trace", async ({ world }) => {
  const { stderr } = lastRun(world)
  expect(stderr).toMatch(/^mockingbird-fleet: /)
  expect(stderr).not.toMatch(/^\s+at .+:\d+:\d+\)?$/m)
})

Then("it prints nothing to standard output", async ({ world }) => {
  expect(lastRun(world).stdout.trim()).toBe("")
})

Then(
  /^its standard output is one JSON document: (a plan|an applied result) with (\d+) changes?$/,
  async ({ world }, outcome: string, count: string) => {
    const run = lastRun(world)
    const result = JSON.parse(run.stdout) as {
      organization: string | null
      applied: boolean
      changes: { action: string }[]
    }
    expect(result.applied).toBe(outcome === "an applied result")
    expect(result.changes.filter((change) => change.action !== "unchanged")).toHaveLength(
      Number(count),
    )
  },
)

// ---- a fleet on the person's machine -------------------------------------------------------

Then(/^(?:her|his) machine runs (.+)$/, async ({ world }, words: string) => {
  const fleet = localFleet(world)
  expect(fleet.state).toBe("ready")
  expect(Object.keys(fleet.services).sort()).toEqual(listed(words).sort())
})

Then("no local fleet starts", async ({ world }) => {
  const run = lastRun(world)
  expect(run.code, `${run.stdout}\n${run.stderr}`).toBe(1)
  // It never got as far as listening: there is no readiness record.
  expect(run.ready).toBeUndefined()
  expect(run.stdout.trim()).toBe("")
})

Then(
  /^the (Resend|Stripe) SDK's call succeeds against "([^"]*)" on (?:her|his) machine$/,
  async ({ world }, vendor: Vendor, service: string) => {
    const reply = await vendorCall(vendor, localService(world, service).url)
    expect(reply.status, reply.text).toBe(200)
    expect(reply.id).toEqual(expect.any(String))
  },
)

Then(
  /^the same (Resend|Stripe) SDK call succeeds against "([^"]*)" of "([^"]*)" in Fleet Cloud and against "\2" on (?:her|his) machine$/,
  async ({ world }, vendor: Vendor, service: string, fleet: string) => {
    const cloud = fleetOf(world, fleet).emulators[service]
    if (!cloud) throw new Error(`Fleet Cloud's "${fleet}" has no emulator "${service}"`)
    for (const base of [cloud.url, localService(world, service).url]) {
      const reply = await vendorCall(vendor, base)
      expect(reply.status, `${base}: ${reply.text}`).toBe(200)
      expect(reply.id, base).toEqual(expect.any(String))
    }
  },
)

Then(
  /^"([^"]*)" on (?:her|his) machine is a PostgreSQL server that answers queries$/,
  async ({ world }, service: string) => {
    const { protocol, url } = localService(world, service)
    expect(protocol).toBe("postgres")
    expect(queryPostgres(url, "select 1 + 1 as two")).toEqual([{ two: 2 }])
  },
)

Then(
  /^"([^"]*)" on (?:her|his) machine listens on the port the file chose$/,
  async ({ world }, service: string) => {
    expect(new URL(localService(world, service).url).port).toBe(String(chosenPort(world)))
  },
)

Then("nothing listens on the port the file chose", async ({ world }) => {
  const refused = await new Promise<boolean>((resolve) => {
    const socket = connect(chosenPort(world), "127.0.0.1")
    socket.once("connect", () => {
      socket.destroy()
      resolve(false)
    })
    socket.once("error", () => resolve(true))
  })
  expect(refused).toBe(true)
})
