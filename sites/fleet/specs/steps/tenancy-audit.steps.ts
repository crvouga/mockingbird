/** Tenancy and access: the audit log. */
import { expect } from "@playwright/test"
import type { DataTable } from "playwright-bdd"
import { idOf, ownerOf, phrase, type Thing } from "../support/tenancy.js"
import type { World } from "../support/world.js"
import { Then, When } from "./common.steps.js"

type Entry = { id: string; actor: string; action: string; target: string; at: string }

const auditOf = async (world: World, org: string) => {
  const id = idOf(world, org)
  const owner = await ownerOf(world, id)
  return (await world.must<{ data: Entry[] }>(owner, "GET", `/orgs/${id}/audit`)).data
}

const latest = async (world: World, org: string) => {
  const [entry] = await auditOf(world, org)
  if (!entry) throw new Error(`The audit log of "${org}" is empty`)
  return entry
}

When(
  phrase("{person} reads the audit log of {string}"),
  async ({ world }, person: string, org: string) => {
    await world.api(person, "GET", `/orgs/${idOf(world, org)}/audit`)
  },
)

/** Compare the newest entries with a `who | did` table; people are recognised by their email. */
function expectEntries(world: World, entries: Entry[], table: DataTable) {
  const expected = table.hashes()
  expect(entries.map((entry) => entry.action)).toEqual(expected.map((row) => row.did))
  for (const [index, row] of expected.entries()) {
    expect(entries[index]?.actor, `entry ${index + 1}: ${row.did}`).toMatch(/^user:usr_[a-z0-9]+:/)
    expect(entries[index]?.actor).toContain(world.email(row.who ?? ""))
  }
}

Then(
  phrase("the audit log of {string} reads, newest first:"),
  async ({ world }, org: string, table: DataTable) => {
    expectEntries(world, await auditOf(world, org), table)
  },
)

Then(
  phrase("the latest entries in the audit log of {string} are:"),
  async ({ world }, org: string, table: DataTable) => {
    expectEntries(world, (await auditOf(world, org)).slice(0, table.hashes().length), table)
  },
)

Then(
  phrase("the audit log of {string} has {int} entries"),
  async ({ world }, org: string, count: string) => {
    expect(await auditOf(world, org)).toHaveLength(Number(count))
  },
)

Then(
  phrase("the latest audit entry of {string} is about the emulator {string} of the fleet {string}"),
  async ({ world }, org: string, emulator: string, fleet: string) => {
    expect(await latest(world, org)).toMatchObject({
      action: "updateEmulator",
      target: `${idOf(world, fleet)}/${emulator}`,
    })
  },
)

Then(
  phrase("every entry in the audit log of {string} is timestamped, never later than now"),
  async ({ world }, org: string) => {
    const entries = await auditOf(world, org)
    expect(entries.length).toBeGreaterThan(0)
    const times = entries.map((entry) => Date.parse(entry.at))
    for (const time of times) expect(time).toBeLessThanOrEqual(Date.now() + 1000)
    expect(times).toEqual([...times].sort((a, b) => b - a))
    expect(new Set(entries.map((entry) => entry.id)).size).toBe(entries.length)
  },
)

Then(
  phrase("the latest audit entry of {string} was made by the person {person}"),
  async ({ world }, org: string, person: string) => {
    const { actor } = await latest(world, org)
    expect(actor).toMatch(/^user:usr_[a-z0-9]+:/)
    expect(actor.endsWith(`:${world.email(person)}`), actor).toBe(true)
  },
)

Then(
  phrase("the latest audit entry of {string} was made by the key {string}"),
  async ({ world }, org: string, name: string) => {
    expect((await latest(world, org)).actor).toBe(`key:${idOf(world, name)}:${name}`)
  },
)

Then(
  phrase("the latest audit entry of {string} was made by the operator"),
  async ({ world }, org: string) => {
    expect(await latest(world, org)).toMatchObject({ actor: "operator", action: "adminUpdateOrg" })
  },
)

When(phrase("the operator changes a quota of {string}"), async ({ world }, org: string) => {
  await world.must("operator", "PATCH", `/admin/orgs/${idOf(world, org)}`, {
    limits: { fleetsPerOrg: 9 },
  })
})

Then("the audit log reveals neither key secrets nor invite links", async ({ world }) => {
  expect(world.last?.status, world.last?.text).toBe(200)
  const secrets = [...world.things.values()].flatMap((thing) =>
    [thing.key, thing.token].filter((value): value is string => typeof value === "string"),
  )
  expect(secrets.length).toBeGreaterThanOrEqual(3)
  for (const secret of secrets) expect(world.last?.text).not.toContain(secret)
  // Nor the part of a key after its public prefix.
  for (const secret of secrets) expect(world.last?.text).not.toContain(secret.slice(-43))
})

When(
  phrase("{person} renames the organization {string} {int} times"),
  async ({ world }, person: string, org: string, count: string) => {
    const id = world.thing<Thing>(org).id
    await world.person(person)
    let remaining = Number(count)
    while (remaining > 0) {
      const batch = Math.min(remaining, 20)
      const replies = await Promise.all(
        Array.from({ length: batch }, (_, index) =>
          world.api(person, "PATCH", `/orgs/${id}`, { name: `${org} ${remaining - index}` }),
        ),
      )
      for (const reply of replies) expect(reply.status, reply.text).toBe(200)
      remaining -= batch
    }
  },
)
