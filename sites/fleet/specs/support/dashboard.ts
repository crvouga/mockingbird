/**
 * A person's hands and eyes on the real dashboard: a Chromium page per person, served by the
 * scenario's own server. Given-state is made through the API (`world`); the behaviour a scenario
 * specifies happens here, in the browser, found the way a person finds it (role, label, text).
 */
import type { Browser, BrowserContext, Download, Locator, Page } from "@playwright/test"
import type { World } from "./world.js"

export const PHONE = { width: 390, height: 844 }

/** Tabs of an organization as a person names them → the last segment of their address. */
export const TAB_PATHS: Record<string, string> = {
  Projects: "",
  Members: "/members",
  Usage: "/usage",
  "API keys": "/keys",
  "Audit log": "/audit",
  Settings: "/settings",
}

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
  /** The questions the browser asked (confirm dialogs), in order. */
  readonly questions: string[] = []
  /** Secrets read off the screen, by the name the scenario gave them. */
  readonly secrets = new Map<string, string>()
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

  /** Answer the next confirmation the dashboard asks, and remember the question. */
  answerNext(accept: boolean): void {
    this.page.once("dialog", (dialog) => {
      this.questions.push(dialog.message())
      void (accept ? dialog.accept() : dialog.dismiss())
    })
  }

  /** A text field, select or checkbox by its label. */
  field(label: string): Locator {
    return this.page.getByLabel(label, { exact: true })
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

  /** The notice that shows a secret once. */
  get secretNotice(): Locator {
    return this.page.getByRole("status")
  }

  /** The secret value currently on screen. */
  async revealed(): Promise<string> {
    return (await this.secretNotice.getByRole("code").innerText()).trim()
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
