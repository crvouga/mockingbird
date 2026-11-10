/**
 * Steps every feature shares. Area-specific steps live beside these in their own
 * `<area>.steps.ts` file. A step's wording must be unique across all files.
 */
import { expect } from "@playwright/test"
import { createBdd, type DataTable } from "playwright-bdd"
import { test } from "../support/fixtures.js"
import { startStack } from "../support/stack.js"

export const { Given, When, Then } = createBdd(test)

/**
 * Run this scenario against its own server, configured with the given environment variables:
 *   Given the server is configured with:
 *     | LIMIT_PROJECTS_PER_ORG | 1 |
 */
Given("the server is configured with:", async ({ world, ownStacks }, table: DataTable) => {
  const stack = await startStack(
    Object.fromEntries(table.raw().map(([key, value]) => [key, value ?? ""])),
  )
  ownStacks.push(stack)
  world.stack = stack
})

Given("{word} is signed in", async ({ world }, person: string) => {
  await world.person(person)
})

Given("{word} owns an organization {string}", async ({ world }, person: string, name: string) => {
  world.things.set(name, await world.must(person, "POST", "/orgs", { name }))
})

Given(
  "{word} has a project {string} in {string}",
  async ({ world }, person: string, name: string, org: string) => {
    const { id } = world.thing<{ id: string }>(org)
    world.things.set(name, await world.must(person, "POST", `/orgs/${id}/projects`, { name }))
  },
)

Then("the request is refused as {string}", async ({ world }, code: string) => {
  expect(world.errorCode, world.last?.text).toBe(code)
})

Then("the request succeeds", async ({ world }) => {
  expect(world.last?.status, world.last?.text).toBeLessThan(300)
})

Then("the response status is {int}", async ({ world }, status: number) => {
  expect(world.last?.status, world.last?.text).toBe(status)
})

Then("the message says {string}", async ({ world }, text: string) => {
  expect(world.errorMessage ?? world.last?.text).toContain(text)
})
