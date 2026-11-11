/**
 * Steps for what survives: stopping and killing the server, looking into object storage, and
 * the controls a member has over an emulator's stored state.
 */
import { expect } from "@playwright/test"
import {
  eventually,
  type FleetView,
  fleetOf,
  orgOf,
  readEmail,
  soleEmulator,
  storagePrefix,
  storedKeys,
  storedKeysOf,
  storedState,
  theEmail,
} from "../support/fleets.js"
import type { World } from "../support/world.js"
import { Given, Then, When } from "./common.steps.js"
import { createCustomer } from "./fleets.steps.js"

/** Re-read a fleet through the API and keep the scenario's copy current. */
const refreshed = async (world: World, fleetName: string) => {
  const fleet = fleetOf(world, fleetName)
  const view = await world.must<FleetView>(fleet.owner, "GET", `/fleets/${fleet.id}`)
  world.things.set(fleetName, { ...view, owner: fleet.owner })
  return view
}

const emailIsStored = async (world: World) => {
  const email = theEmail(world)
  const state = await storedState(world, fleetOf(world, email.fleet), email.emulator)
  return state?.text.includes(email.id) ?? false
}

// ---- stopping the server -------------------------------------------------------------------

const ownDeployment = (world: World, ownStacks: unknown[]) => {
  if (!ownStacks.includes(world.stack))
    throw new Error("Stop the server only on a deployment the scenario owns")
}

When("the server is killed without warning and started again", async ({ world, ownStacks }) => {
  ownDeployment(world, ownStacks)
  await world.stack.server.stop("SIGKILL")
  await world.stack.restart()
})

When("the server is shut down gracefully and started again", async ({ world, ownStacks }) => {
  ownDeployment(world, ownStacks)
  await world.stack.restart()
})

Then("the email is still there", async ({ world }) => {
  const reply = await readEmail(world)
  expect(reply.status, reply.text).toBe(200)
})

Then("the email is gone", async ({ world }) => {
  const reply = await readEmail(world)
  expect(reply.status, reply.text).toBe(404)
})

// ---- object storage ------------------------------------------------------------------------

Then("object storage already holds the email", async ({ world }) => {
  expect(await emailIsStored(world)).toBe(true)
})

Then("within {int} seconds object storage holds the email", async ({ world }, seconds: number) => {
  await eventually("the email is in object storage", seconds, () => emailIsStored(world))
})

Then("object storage holds nothing for {string}", async ({ world }, fleet: string) => {
  expect(await storedKeysOf(world, fleetOf(world, fleet))).toEqual([])
})

Then(
  "object storage holds nothing for the {string} emulator of {string}",
  async ({ world }, emulator: string, fleet: string) => {
    expect(await storedKeysOf(world, fleetOf(world, fleet), emulator)).toEqual([])
  },
)

Then(
  "object storage holds state for the {string} emulator of {string}",
  async ({ world }, emulator: string, fleet: string) => {
    expect(await storedState(world, fleetOf(world, fleet), emulator)).toBeDefined()
  },
)

Then("every object in the bucket is under {string}", async ({ world }, prefix: string) => {
  const keys = await storedKeys(world)
  expect(keys.length).toBeGreaterThan(0)
  expect(keys.filter((key) => !key.startsWith(prefix))).toEqual([])
  expect(prefix.startsWith(storagePrefix(world))).toBe(true)
})

Then(
  "object storage holds one object for each emulator of {string}",
  async ({ world }, fleetName: string) => {
    const fleet = fleetOf(world, fleetName)
    expect((await storedKeysOf(world, fleet)).sort()).toEqual(
      Object.keys(fleet.emulators)
        .map((name) => `${storagePrefix(world)}fleets/${fleet.id}/${name}/state.json.gz`)
        .sort(),
    )
  },
)

Then("the bucket is empty", async ({ world }) => {
  expect(await storedKeys(world)).toEqual([])
})

// ---- durability settings -------------------------------------------------------------------

Given(
  "the emulator of {string} saves buffered changes every {int} ms",
  async ({ world }, fleetName: string, flushIntervalMs: number) => {
    const fleet = fleetOf(world, fleetName)
    await world.must(fleet.owner, "PATCH", `/fleets/${fleet.id}/emulators/${soleEmulator(fleet)}`, {
      flushIntervalMs,
    })
  },
)

When(
  "{word} changes the emulator of {string} to {word} durability",
  async ({ world }, person: string, fleetName: string, durability: string) => {
    const fleet = fleetOf(world, fleetName)
    await world.api(person, "PATCH", `/fleets/${fleet.id}/emulators/${soleEmulator(fleet)}`, {
      durability,
    })
    expect(world.last?.status, world.last?.text).toBe(200)
  },
)

Then(
  "the emulator of {string} is {string}",
  async ({ world }, fleetName: string, durability: string) => {
    const fleet = await refreshed(world, fleetName)
    expect(fleet.emulators[soleEmulator(fleet)]?.durability).toBe(durability)
  },
)

Then("the emulator of {string} reports unsaved changes", async ({ world }, fleetName: string) => {
  const fleet = await refreshed(world, fleetName)
  expect(fleet.emulators[soleEmulator(fleet)]?.status).toMatchObject({
    dirty: true,
    lastSavedAt: null,
  })
})

Then(
  "the emulator of {string} reports its state as saved",
  async ({ world }, fleetName: string) => {
    const fleet = await refreshed(world, fleetName)
    const status = fleet.emulators[soleEmulator(fleet)]?.status
    expect(status).toMatchObject({ dirty: false, lastSavedAt: expect.any(String) })
    expect(status?.storedBytes).toBeGreaterThan(0)
  },
)

// ---- flush, export, reset ------------------------------------------------------------------

const emulatorAction = async (
  world: World,
  person: string,
  method: string,
  fleetName: string,
  emulator: string | undefined,
  action: string,
) => {
  const fleet = fleetOf(world, fleetName)
  return world.api(
    person,
    method,
    `/fleets/${fleet.id}/emulators/${emulator ?? soleEmulator(fleet)}${action}`,
  )
}

When(
  "{word} asks the emulator of {string} to save its state now",
  async ({ world }, person: string, fleet: string) => {
    await emulatorAction(world, person, "POST", fleet, undefined, "/flush")
  },
)
When(
  "{word} asks the {string} emulator of {string} to save its state now",
  async ({ world }, person: string, emulator: string, fleet: string) => {
    await emulatorAction(world, person, "POST", fleet, emulator, "/flush")
  },
)

When("{word} resets the emulator of {string}", async ({ world }, person: string, fleet: string) => {
  await emulatorAction(world, person, "POST", fleet, undefined, "/reset")
})

When(
  "{word} downloads the state of the emulator of {string}",
  async ({ world }, person: string, fleet: string) => {
    await emulatorAction(world, person, "GET", fleet, undefined, "/state")
  },
)

type StateDocument = { format: string; target: string; namespaces: Record<string, unknown> }

Then("the state document is for the {string} emulator", async ({ world }, target: string) => {
  expect(world.last?.body).toMatchObject({ format: "mockingbird.fleet-cloud.state/v1", target })
})

Then(
  "the state document holds the email in the namespace {string}",
  async ({ world }, namespace: string) => {
    const document = world.last?.body as StateDocument
    expect(JSON.stringify(document.namespaces[namespace] ?? null)).toContain(theEmail(world).id)
  },
)

Then(
  "the state document has a namespace {string} without the email",
  async ({ world }, namespace: string) => {
    const document = world.last?.body as StateDocument
    expect(Object.keys(document.namespaces)).toContain(namespace)
    expect(JSON.stringify(document.namespaces[namespace])).not.toContain(theEmail(world).id)
  },
)

// ---- removing and replacing ----------------------------------------------------------------

When(
  "{word} deletes the {string} emulator of {string}",
  async ({ world }, person: string, emulator: string, fleet: string) => {
    await emulatorAction(world, person, "DELETE", fleet, emulator, "")
    expect(world.last?.status, world.last?.text).toBe(200)
  },
)

Then(
  "the {string} emulator of {string} is no longer found",
  async ({ world }, emulator: string, fleetName: string) => {
    const reply = await world.emulator(fleetOf(world, fleetName).slug, emulator, "GET", "/emails")
    expect(reply.status, reply.text).toBe(404)
    expect(world.errorMessage).toBe("Emulator not found")
  },
)

When("{word} deletes the fleet {string}", async ({ world }, person: string, fleetName: string) => {
  await world.api(person, "DELETE", `/fleets/${fleetOf(world, fleetName).id}`)
})

Then("the fleet {string} is no longer found", async ({ world }, fleetName: string) => {
  const fleet = fleetOf(world, fleetName)
  const reply = await world.emulator(fleet.slug, soleEmulator(fleet), "GET", "/emails")
  expect(reply.status, reply.text).toBe(404)
  expect(world.errorMessage).toBe("Fleet not found")
})

When("{word} deletes her organization", async ({ world }, person: string) => {
  await world.api(person, "DELETE", `/orgs/${orgOf(world, person).id}`)
})

When(
  "{word} replaces the {string} emulator of {string} with a {word} emulator",
  async ({ world }, person: string, emulator: string, fleetName: string, vendor: string) => {
    const fleet = fleetOf(world, fleetName)
    await world.api(person, "PUT", `/fleets/${fleet.id}/emulators/${emulator}`, {
      target: vendor.toLowerCase(),
      durability: fleet.emulators[emulator]?.durability ?? "strict",
    })
  },
)

Then(
  "a Stripe SDK can create a customer through the {string} emulator of {string}",
  async ({ world }, emulator: string, fleet: string) => {
    const reply = await createCustomer(world, fleet, emulator)
    expect(reply.status, reply.text).toBe(200)
  },
)
