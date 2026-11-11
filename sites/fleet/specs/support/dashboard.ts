/**
 * A person's hands and eyes on the real dashboard: a Chromium page per person, served by the
 * scenario's own server. Given-state is made through the API (`world`); the behaviour a scenario
 * specifies happens here, in the browser, found the way a person finds it (role, label, text).
 */
import type { Browser, BrowserContext, Download, Locator, Page } from "@playwright/test"
import { auditSurface } from "../../src/ui/audit.js"
import type { World } from "./world.js"

export const PHONE = { width: 390, height: 844 }

/** Tabs of an organization as a person names them → the last segment of their address. */
export const TAB_PATHS: Record<string, string> = {
  Projects: "",
  Configuration: "/configuration",
  Members: "/members",
  Usage: "/usage",
  "API keys": "/keys",
  "Audit log": "/audit",
  Settings: "/settings",
}

/** Text to match exactly inside a regular expression. */
export const literal = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

export class Dashboard {
  private readonly pages = new Map<string, Page>()
  private readonly contexts: BrowserContext[] = []
  private current: Page | undefined
  /** Every request any page made: method, URL and what kind of resource asked for it. */
  readonly requests: { method: string; url: string; type: string }[] = []
  /** Uncaught errors in any page; a scenario fails if there are any when it ends. */
  readonly errors: string[] = []
  /** What the browser refused to load or run under the page's content security policy. */
  readonly blocked: string[] = []
  /**
   * Dialogs the browser opened (`confirm`, `alert`, …). The dashboard asks on a screen of its
   * own and answers inline, never in a dialog: a scenario fails if there are any when it ends.
   */
  readonly dialogs: string[] = []
  download: Download | undefined
  /** Things to stop when the scenario ends. */
  readonly cleanups: (() => Promise<unknown>)[] = []

  constructor(
    private readonly world: World,
    private readonly browser: Browser,
  ) {}

  /** The page of the person acting now. */
  get page(): Page {
    if (!this.current) throw new Error("Nobody has a browser open yet")
    return this.current
  }

  private async open(name: string, viewport?: { width: number; height: number }): Promise<Page> {
    const context = await this.browser.newContext({
      locale: "en-US",
      timezoneId: "UTC",
      acceptDownloads: true,
      permissions: ["clipboard-read", "clipboard-write"],
      ...(viewport ? { viewport } : {}),
    })
    this.contexts.push(context)
    const page = await context.newPage()
    page.on("request", (request) =>
      this.requests.push({
        method: request.method(),
        url: request.url(),
        type: request.resourceType(),
      }),
    )
    page.on("pageerror", (error) => this.errors.push(`${name}: ${error.message}`))
    page.on("dialog", (dialog) => {
      this.dialogs.push(`${name}: ${dialog.type()} "${dialog.message()}"`)
      void dialog.dismiss()
    })
    page.on("console", (message) => {
      if (message.text().includes("Content Security Policy")) this.blocked.push(message.text())
    })
    this.pages.set(name, page)
    this.current = page
    return page
  }

  /** A browser nobody is signed in to. It becomes the one acting. */
  visitor(name = "visitor", viewport?: { width: number; height: number }): Promise<Page> {
    return this.open(name, viewport)
  }

  /**
   * A person's browser, already signed in: their session (made through the API) is put in the
   * browser as its cookie, which is all sign-in leaves behind. It becomes the one acting.
   */
  async signedIn(person: string, viewport?: { width: number; height: number }): Promise<Page> {
    const known = this.pages.get(person)
    if (known) {
      this.current = known
      return known
    }
    const credential = await this.world.person(person)
    if (credential.kind !== "session") throw new Error(`${person} has no browser session`)
    const [name = "", ...value] = credential.cookie.split("=")
    const page = await this.open(person, viewport)
    await page.context().addCookies([{ name, value: value.join("="), url: this.world.url }])
    return page
  }

  /** Make an already open browser the one acting. */
  switchTo(name: string): Page {
    const page = this.pages.get(name)
    if (!page) throw new Error(`${name} has no browser open`)
    this.current = page
    return page
  }

  /** Go to an address of the dashboard and wait until it has drawn something. */
  async goto(path: string): Promise<void> {
    await this.page.goto(new URL(path, this.world.url).href)
    await this.settled()
  }

  /** The dashboard has replaced "Loading…" with a screen and is not in the middle of redrawing. */
  async settled(): Promise<void> {
    await this.page.getByText("Loading…", { exact: true }).waitFor({ state: "detached" })
    await this.idle()
  }

  /**
   * Wait until the dashboard has come to rest, as a person does before their next move: it marks
   * itself `aria-busy` while an action or a redraw is under way. Pages that are not the
   * dashboard (the identity provider's) are never busy.
   */
  async idle(): Promise<void> {
    await this.page.waitForFunction(
      () => document.getElementById("app")?.getAttribute("aria-busy") !== "true",
    )
  }

  /** A text field or select by its label. */
  field(label: string): Locator {
    return this.page.getByLabel(label, { exact: true })
  }

  /** A set of choices (radio buttons) by its legend. */
  choices(legend: string): Locator {
    return this.page.getByRole("group", { name: legend, exact: true })
  }

  /** One of a set of choices, by the start of its label ("Admin" of "Admin: Everything an …"). */
  choice(legend: string, option: string): Locator {
    return this.choices(legend).getByRole("radio", { name: new RegExp(`^${literal(option)}`) })
  }

  /**
   * The control a field's problem is announced on: the text field or select labelled so, or the
   * first of the choices under that legend.
   */
  async control(label: string): Promise<Locator> {
    const field = this.field(label)
    if ((await field.count()) > 0) return field
    return this.choices(label).getByRole("radio").first()
  }

  /** The one form of a mutation screen. */
  get form(): Locator {
    return this.page.getByRole("main").locator("form")
  }

  /** What the form says went wrong as a whole: its summary, inside the form. */
  get formError(): Locator {
    return this.form.getByRole("alert")
  }

  /** Every problem the screen points out: under fields, and in the form's summary. */
  get problems(): Locator {
    return this.page.locator(".field-error:visible, .form-error")
  }

  button(name: string, within: Locator | Page = this.page): Locator {
    return within.getByRole("button", { name, exact: true })
  }

  /** A row of a named list, found by text it shows. */
  row(list: string, text: string): Locator {
    return this.page
      .getByRole("list", { name: list, exact: true })
      .getByRole("listitem")
      .filter({ hasText: text })
  }

  /** An emulator's card on the fleet screen. */
  emulator(name: string): Locator {
    return this.page.getByRole("article", { name, exact: true })
  }

  /** A setting of the screen's properties ("Name", "Who can call it"), found by its name. */
  setting(name: string, within: Locator | Page = this.page): Locator {
    return within
      .locator(".prop")
      .filter({ has: this.page.getByRole("term").getByText(name, { exact: true }) })
  }

  /** A value shown with a button that copies it, found by the value. */
  copyable(value: string, within: Locator | Page = this.page): Locator {
    return within.locator(".copy").filter({ has: this.page.getByText(value, { exact: true }) })
  }

  /** The secret a result screen shows, once. */
  get secret(): Locator {
    return this.page.getByRole("main").locator(".secret").getByRole("code")
  }

  /** The secret value currently on screen. */
  async revealed(): Promise<string> {
    return (await this.secret.innerText()).trim()
  }

  /** What the drawn `<main>` says it is: a query or a mutation, and which route or state. */
  surface(): Promise<{ kind: string | null; route: string | null }> {
    return this.page.evaluate(() => {
      const main = document.querySelector("#app main[data-surface]")
      return {
        kind: main?.getAttribute("data-surface") ?? null,
        route: main?.getAttribute("data-route") ?? null,
      }
    })
  }

  /**
   * The dashboard's design rules (`src/ui/audit.ts`), checked in the page: what breaks them.
   * `kind` is what the screen must be; by default, what it says it is.
   */
  audit(kind?: "query" | "mutation"): Promise<string[]> {
    return this.page.evaluate(
      `(${auditSurface})(document.querySelector("#app"), ${JSON.stringify(kind)})`,
    )
  }

  /**
   * Anything on the page that announces itself apart from the place it is about: a toast,
   * snackbar or flash message, feedback outside the screen's `<main>`, or anything floating.
   */
  toasts(): Promise<string[]> {
    return this.page.evaluate(() => {
      const found: string[] = []
      const name = (element: Element) =>
        `<${element.tagName.toLowerCase()} class="${element.getAttribute("class") ?? ""}"> "${(element.textContent ?? "").trim().slice(0, 40)}"`
      for (const element of document.querySelectorAll("body *")) {
        if (/toast|snackbar|flash|banner/i.test(element.getAttribute("class") ?? ""))
          found.push(`named like a toast: ${name(element)}`)
        const position = getComputedStyle(element).position
        if (position === "fixed" || position === "sticky")
          found.push(`floating (${position}): ${name(element)}`)
      }
      for (const live of document.querySelectorAll(
        "[role=alert], [role=status], [role=log], [aria-live]",
      ))
        if (!live.closest("main")) found.push(`feedback outside the screen: ${name(live)}`)
      return found
    })
  }

  /** The widest the page's content is, against the width of the window. */
  overflow(): Promise<{ content: number; window: number }> {
    return this.page.evaluate(() => ({
      content: document.documentElement.scrollWidth,
      window: document.documentElement.clientWidth,
    }))
  }

  async close(): Promise<void> {
    await Promise.all(this.cleanups.map((stop) => stop().catch(() => {})))
    await Promise.all(this.contexts.map((context) => context.close().catch(() => {})))
  }
}
