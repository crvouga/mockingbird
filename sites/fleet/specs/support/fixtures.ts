import { test as base } from "playwright-bdd"
import { Dashboard } from "./dashboard.js"
import { type Stack, startStack } from "./stack.js"
import { World } from "./world.js"

type WorkerFixtures = {
  /** One default stack per worker, shared by scenarios that need no special configuration. */
  sharedStack: Stack
}
type ScenarioFixtures = {
  world: World
  /** Stacks a scenario started for itself (custom configuration); stopped when it ends. */
  ownStacks: Stack[]
  /** The dashboard in a real browser. Only scenarios that ask for it start one. */
  dash: Dashboard
}

let counter = 0

export const test = base.extend<ScenarioFixtures, WorkerFixtures>({
  sharedStack: [
    // biome-ignore lint/correctness/noEmptyPattern: Playwright requires the destructured form.
    async ({}, use) => {
      const stack = await startStack()
      await use(stack)
      await stack.stop()
    },
    { scope: "worker" },
  ],
  // biome-ignore lint/correctness/noEmptyPattern: Playwright requires the destructured form.
  ownStacks: async ({}, use) => {
    const stacks: Stack[] = []
    await use(stacks)
    await Promise.all(stacks.map((stack) => stack.stop()))
  },
  world: async ({ sharedStack }, use, testInfo) => {
    const tag = `${testInfo.workerIndex}${(counter++).toString(36)}${Math.random().toString(36).slice(2, 6)}`
    await use(new World(sharedStack, tag))
  },
  dash: async ({ world, browser }, use) => {
    const dash = new Dashboard(world, browser)
    await use(dash)
    await dash.close()
    if (dash.errors.length > 0)
      throw new Error(`The dashboard threw in the browser:\n${dash.errors.join("\n")}`)
    if (dash.dialogs.length > 0)
      throw new Error(`The dashboard opened a dialog:\n${dash.dialogs.join("\n")}`)
  },
})
