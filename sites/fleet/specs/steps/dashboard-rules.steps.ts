/**
 * The dashboard's design rules in the browser: every screen is a query or a mutation and keeps to
 * its kind (`src/ui/audit.ts`), feedback stays in the screen it is about, and the focus goes where
 * the person needs to look.
 */
import { expect, type Route } from "@playwright/test"
import type { DataTable } from "playwright-bdd"
import { ROUTES, to } from "../../src/ui/routes.js"
import type { Dashboard } from "../support/dashboard.js"
import { idOf, userId } from "../support/tenancy.js"
import type { World } from "../support/world.js"
import { Given, Then, When } from "./common.steps.js"

/** What one screen looked like when the scenario visited it. */
type Visit = {
  path: string
  /** The route whose address was opened. */
  route: { id: string; kind: string }
  drawn: { kind: string | null; route: string | null }
  problems: string[]
  /** For a form sent wrong: how many problems it pointed out, and where the focus went. */
  pointed?: number
  focus?: string
}
const visits = new WeakMap<World, Visit[]>()
const visited = (world: World) => {
  const found = visits.get(world)
  if (!found) throw new Error("No screens were visited")
  return found
}

/** Every route parameter, filled with the things the Background made. */
async function parameters(world: World): Promise<Record<string, Record<string, string>>> {
  const invite = world.thing<{ id: string; token: string }>("the invite for Linus")
  const common = {
    org: idOf(world, "Acme"),
    project: idOf(world, "Web app"),
    fleet: idOf(world, "Staging"),
    user: await userId(world, "Grace"),
    invite: invite.id,
    key: idOf(world, "ci"),
    token: idOf(world, "laptop"),
    target: "stripe",
    name: "resend",
  }
  // An invite link carries the invite's own code, not the id of a personal token.
  return { common, "invite.accept": { ...common, token: invite.token } }
}

/** Open a route's address in the browser of whoever may: a visitor for the sign-in screens. */
async function open(dash: Dashboard, path: string, isPublic: boolean) {
  if (isPublic) {
    try {
      dash.switchTo("visitor")
    } catch {
      await dash.visitor()
    }
  } else dash.switchTo("Ada")
  await dash.goto(path)
}

When("they open every screen of the dashboard in turn", async ({ dash, world }) => {
  const params = await parameters(world)
  const found: Visit[] = []
  for (const route of ROUTES) {
    const path = to(route.id, params[route.id] ?? params.common)
    await open(dash, path, "public" in route)
    found.push({
      path,
      route,
      drawn: await dash.surface(),
      // Checked as the kind of screen it says it is; whether that is the right one comes next.
      problems: [...(await dash.audit()), ...(await dash.toasts())],
    })
  }
  visits.set(world, found)
})

When(
  "they send every form of the dashboard without filling it in properly",
  async ({ dash, world }) => {
    const params = await parameters(world)
    const found: Visit[] = []
    for (const route of ROUTES) {
      if (route.kind !== "mutation" || !("fields" in route)) continue
      const path = to(route.id, params[route.id] ?? params.common)
      await open(dash, path, "public" in route)
      // Empty every field that can be typed in; choices keep the value they have now.
      const typed = dash.form.locator("input:is([type=text], [type=email], [type=password])")
      for (const field of await typed.all()) await field.fill("")
      for (const field of await dash.form.getByRole("spinbutton").all()) await field.fill("")
      await dash.form.getByRole("button").click()
      await expect(dash.problems.first()).toBeVisible()
      await dash.idle()
      found.push({
        path,
        route,
        drawn: await dash.surface(),
        problems: [...(await dash.audit("mutation")), ...(await dash.toasts())],
        pointed: await dash.problems.count(),
        focus: await dash.page.evaluate(() => {
          const form = document.querySelector("main form")
          const active = document.activeElement
          const summary = form?.querySelector(".form-error")
          // The control a field's problem is announced on: a text field, or the chosen radio.
          const first = [...(form?.querySelectorAll("[aria-invalid=true]") ?? [])].find(
            (control) => !control.matches("[type=radio]:not(:checked)"),
          )
          if (summary) return active === summary ? "summary" : "elsewhere"
          return active && active === first ? "first problem" : "elsewhere"
        }),
      })
    }
    visits.set(world, found)
  },
)

/**
 * A route's address draws that route's screen, as the kind the route declares. The table names
 * the routes whose address draws something else here, each a query: a shell state such as
 * `gone` or `managed`, or another route's screen.
 */
Then(
  "each one is drawn as the kind of screen its route declares, except:",
  async ({ world }, table: DataTable) => {
    const instead = new Map(table.hashes().map((row) => [row.route, row["drawn as"]]))
    for (const id of instead.keys()) expect(ROUTES.map((route) => route.id as string)).toContain(id)
    const wrong = visited(world)
      .filter(({ route, drawn }) => {
        const other = instead.get(route.id)
        const expected = other
          ? { kind: "query", route: other }
          : { kind: route.kind, route: route.id }
        return JSON.stringify(drawn) !== JSON.stringify(expected)
      })
      .map((visit) => `${visit.path}: drawn ${JSON.stringify(visit.drawn)}`)
    expect(wrong).toEqual([])
    expect(visited(world).length).toBe(ROUTES.length)
  },
)

Then("none of them breaks a design rule", async ({ world }) => {
  const broken = visited(world).flatMap((visit) =>
    visit.problems.map((problem) => `${visit.path}: ${problem}`),
  )
  expect(broken).toEqual([])
})

Then("each one points out at least one problem, in the form", async ({ world }) => {
  const forms = visited(world)
  expect(forms.length).toBe(
    ROUTES.filter((route) => route.kind === "mutation" && "fields" in route).length,
  )
  expect(forms.filter((visit) => !visit.pointed).map((visit) => visit.path)).toEqual([])
  expect(
    forms
      .filter(
        ({ route, drawn }) =>
          JSON.stringify(drawn) !== JSON.stringify({ kind: "mutation", route: route.id }),
      )
      .map((visit) => visit.path),
  ).toEqual([])
})

Then("each one moves the focus to the first problem", async ({ world }) => {
  const lost = visited(world)
    .filter((visit) => visit.focus === "elsewhere")
    .map((visit) => visit.path)
  expect(lost).toEqual([])
})

// ---- one screen ----------------------------------------------------------------------------

Then("the screen keeps the design rules", async ({ dash }) => {
  await expect(dash.page.getByRole("heading", { level: 1 })).toBeVisible()
  await dash.idle()
  expect(await dash.audit()).toEqual([])
  expect(await dash.toasts()).toEqual([])
})

Then("the screen is the {string} state", async ({ dash }, state: string) => {
  await expect(dash.page.getByRole("heading", { level: 1 })).toBeVisible()
  expect(await dash.surface()).toEqual({ kind: "query", route: state })
})

Then("nothing on the page announces itself outside the screen", async ({ dash }) => {
  expect(await dash.toasts()).toEqual([])
})

When(
  "they fill in {string} with {string} and send the form",
  async ({ dash }, label: string, value: string) => {
    await dash.idle()
    await dash.field(label).fill(value)
    await dash.form.getByRole("button").click()
    await dash.idle()
  },
)

// ---- while a change is being sent ----------------------------------------------------------

const held = new WeakMap<World, Route[]>()

Given("the server holds every change until it is told to answer", async ({ dash, world }) => {
  const waiting: Route[] = []
  held.set(world, waiting)
  // Reads go through; a change waits here until the scenario lets it go on to the real server.
  await dash.page.route("**/api/v1/**", (route) =>
    route.request().method() === "GET" ? route.continue() : void waiting.push(route),
  )
})

When("the server answers", async ({ dash, world }) => {
  for (const route of held.get(world) ?? []) await route.continue()
  await dash.page.unrouteAll({ behavior: "ignoreErrors" })
  await dash.idle()
})

When("they press {string} without waiting", async ({ dash }, name: string) => {
  await dash.idle()
  await dash.button(name).click()
  await expect(dash.form).toHaveAttribute("aria-busy", "true")
})

When("they press Enter in {string}", async ({ dash }, label: string) => {
  await dash.field(label).press("Enter")
})

Then("the form is busy", async ({ dash }) => {
  await expect(dash.form).toHaveAttribute("aria-busy", "true")
})

Then("the button {string} is disabled", async ({ dash }, name: string) => {
  await expect(dash.button(name)).toBeDisabled()
})

Then("only one project was created in {string}", async ({ world }, org: string) => {
  const owner = [...world.people.keys()][0] ?? ""
  const { data } = await world.must<{ data: unknown[] }>(
    owner,
    "GET",
    `/orgs/${idOf(world, org)}/projects`,
  )
  expect(data).toHaveLength(1)
})

// ---- where the focus is --------------------------------------------------------------------

Then("the page heading has the focus", async ({ dash }) => {
  await expect(dash.page.getByRole("heading", { level: 1 })).toBeFocused()
})

Then("the field {string} has the focus", async ({ dash }, label: string) => {
  await expect(await dash.control(label)).toBeFocused()
})

Then("the form's summary has the focus", async ({ dash }) => {
  await expect(dash.formError).toBeFocused()
})
