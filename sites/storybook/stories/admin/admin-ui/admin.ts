/**
 * The shared admin UI (`packages/admin-ui`), mounted from source into a story against a real
 * emulator running in the browser. The emulator serves `GET /__admin/ui` (the document
 * `packages/service/core/src/admin-ui.ts` renders); the story reads the boot config out of that
 * document and mounts `src/browser.tsx` with it, so an edit to the client re-renders at once.
 * Every admin request goes to the emulator through `env.fetch`, and the address the UI reads its
 * `#view`, `?namespace=` and `?admin_key=` from is the emulator's, kept in memory.
 */
import type * as Browser from "@crvouga/mockingbird-admin-ui/browser"
import type {
  AdminConfig,
  AdminEnvironment,
  MembersConfig,
} from "@crvouga/mockingbird-admin-ui/browser"
import type { StoryObj } from "@storybook/html-vite"
import { userEvent, waitFor, within } from "storybook/test"
import { frame, frameDocument } from "../../../src/frame.js"
import type { Emulator } from "../../../src/story.js"
import { brandCatalog } from "./brand.js"

// A glob, not an import: Vite compiles the `.tsx` source, and this package's `tsc` (which has no
// JSX setting) checks it against the package's declarations instead of reading the source.
const modules = import.meta.glob<typeof Browser>(
  "../../../../../packages/admin-ui/src/browser.tsx",
  {
    eager: true,
  },
)
const browser = Object.values(modules)[0] as typeof Browser

/** The files every story of the shell draws. */
export const SHELL_SOURCES = [
  "packages/admin-ui/src/browser.tsx",
  "packages/admin-ui/src/components.tsx",
  "packages/admin-ui/src/controls.tsx",
  "packages/admin-ui/src/palette.tsx",
  "packages/admin-ui/src/environment.ts",
  "packages/admin-ui/src/api.ts",
  "packages/admin-ui/src/brand.ts",
  "packages/admin-ui/src/model.ts",
  "packages/admin-ui/src/document.ts",
  "packages/service/core/src/admin-ui.ts",
]

/** Where a story's admin opens: an emulator in the state the screen shows, at its origin. */
export type AdminVisit = {
  emulator: Emulator
  origin: string
  /** The admin page's path. Default `/__admin/ui`. */
  path?: string
  /** Boot config. Default: read from the document the emulator serves at `path`. */
  config?: AdminConfig
  /** Answers the UI's requests in place of the emulator (a stalled or failing network). */
  fetch?: AdminEnvironment["fetch"]
  panelScript?: AdminEnvironment["panelScript"]
}

export type AdminOptions = {
  /** The screen, as the `#hash` the shell keeps it in: `state`, `clock`, `journal`, … */
  view?: string
  /** Query string on the admin's address: `?namespace=`, `?admin_key=`. */
  query?: string
  dark?: boolean
  /** Draw the shell this many pixels wide (a phone: 390). */
  width?: number
  /** Text the screen shows once its data has loaded; the story waits for it. */
  ready?: string | RegExp
}

/** The boot config an emulator's own admin document mounts the client with. */
export async function servedConfig(emulator: Emulator, url: string): Promise<AdminConfig> {
  const response = await emulator.fetch(new Request(url))
  const html = await response.text()
  const call = 'MockingbirdAdmin.mount(document.getElementById("admin-root"), '
  const start = html.lastIndexOf(call)
  const end = html.indexOf(");\n</script>", start)
  if (start < 0 || end < 0) throw new Error(`${url} served no admin document (${response.status})`)
  return JSON.parse(html.slice(start + call.length, end)) as AdminConfig
}

/**
 * `fetch` for the UI: paths resolve against the emulator's origin and the emulator answers,
 * except the brand catalog, which `brands` answers (see `./brand.ts`).
 */
export const emulatorFetch =
  (
    emulator: Emulator,
    origin: string,
    brands: Record<string, unknown> = {},
  ): NonNullable<AdminEnvironment["fetch"]> =>
  (input, init) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
    const url = new URL(raw, origin)
    if (url.pathname.endsWith("/ui/brands.json") && Object.keys(brands).length)
      return Promise.resolve(Response.json(brands))
    return emulator.fetch(new Request(url, init))
  }

/** The vendor chips of every emulator a config presents. */
export async function brandsFor(config: AdminConfig): Promise<Record<string, unknown>> {
  const services = new Set([config.service, ...(config.apis ?? []).map((api) => api.service)])
  return Object.assign({}, ...(await Promise.all([...services].map(brandCatalog))))
}

let disposeLast: (() => void) | undefined

/** A host element for one mount; the previous story's mount is disposed first. */
function host(options: AdminOptions): { outer: HTMLElement; inner: HTMLElement } {
  disposeLast?.()
  disposeLast = undefined
  try {
    sessionStorage.removeItem("mockingbird-admin-key")
    sessionStorage.setItem("mockingbird-admin-theme", options.dark ? "dark" : "light")
  } catch {}
  const outer = document.createElement("div")
  outer.style.cssText = `min-height:100vh;background:${options.dark ? "#0b0f14" : "#f5f7fa"}`
  const inner = document.createElement("div")
  inner.style.cssText = options.width ? `width:${options.width}px;max-width:100%;margin:0 auto` : ""
  outer.append(inner)
  return { outer, inner }
}

/** Wait for the text a loaded screen shows, so `verify` and screenshots see real data. */
export async function shows(canvas: HTMLElement, text: string | RegExp): Promise<void> {
  await waitFor(
    () => {
      const body = canvas.textContent ?? ""
      if (typeof text === "string" ? !body.includes(text) : !text.test(body))
        throw new Error(`The admin never showed ${String(text)}`)
    },
    { timeout: 10_000, onTimeout: (error) => error },
  )
}

/** Open the Ant Design select labelled `name`, type `search`, and pick the option matching `option`. */
export async function choose(
  canvas: HTMLElement,
  name: string,
  search: string,
  option: string | RegExp,
): Promise<void> {
  await userEvent.click(within(canvas).getByRole("combobox", { name }))
  await userEvent.keyboard(search)
  const item = await waitFor(
    () => {
      const found = [
        ...canvas.querySelectorAll<HTMLElement>(".ant-select-item-option-content"),
      ].find((element) =>
        typeof option === "string"
          ? element.textContent === option
          : option.test(element.textContent ?? ""),
      )
      if (!found) throw new Error(`No option ${String(option)} in ${name}`)
      return found
    },
    { timeout: 10_000, onTimeout: (error) => error },
  )
  await userEvent.click(item)
}

/** The admin shell on an emulator `setup` has put in the state the screen shows. */
export function admin(
  setup: () => AdminVisit | Promise<AdminVisit>,
  options: AdminOptions = {},
): StoryObj {
  return {
    loaders: [
      async () => {
        const visit = await setup()
        const path = visit.path ?? "/__admin/ui"
        const config =
          visit.config ?? (await servedConfig(visit.emulator, `${visit.origin}${path}`))
        return { visit, config, path, brands: await brandsFor(config) }
      },
    ],
    render: (_args, context) => {
      const { visit, config, path, brands } = context.loaded as {
        visit: AdminVisit
        config: AdminConfig
        path: string
        brands: Record<string, unknown>
      }
      const { outer, inner } = host(options)
      const href = `${visit.origin}${path}${options.query ?? ""}${options.view ? `#${options.view}` : ""}`
      disposeLast = browser.mount(inner, config, {
        fetch: visit.fetch ?? emulatorFetch(visit.emulator, visit.origin, brands),
        location: { href },
        shortcutTarget: inner,
        ...(visit.panelScript !== undefined ? { panelScript: visit.panelScript } : {}),
      })
      return outer
    },
    ...(options.ready
      ? {
          play: async ({ canvasElement }) => shows(canvasElement, options.ready as string | RegExp),
        }
      : {}),
  }
}

/** The members screen (`mountMembers`) an application embeds, on an API `fetch` answers. */
export function members(
  config: MembersConfig,
  fetch: NonNullable<AdminEnvironment["fetch"]>,
  options: AdminOptions = {},
): StoryObj {
  return {
    render: () => {
      const { outer, inner } = host({ ...options, dark: config.dark })
      inner.style.padding = "32px 24px"
      disposeLast = browser.mountMembers(inner, config, {
        fetch,
        location: { href: "https://app.example/admin" },
      })
      return outer
    },
    ...(options.ready
      ? {
          play: async ({ canvasElement }) => shows(canvasElement, options.ready as string | RegExp),
        }
      : {}),
  }
}

/**
 * The admin document an emulator serves, as it serves it (prebuilt client inlined), in a frame.
 * A frame drawn from markup has no address of its own (`about:srcdoc`), so the client is handed
 * the page's real one through `mount`'s third argument, the embedder's `env`: its `#view` and
 * relative requests resolve against the emulator, and the frame sends those to it.
 */
export function servedDocument(html: string, href: string): string {
  const call = 'MockingbirdAdmin.mount(document.getElementById("admin-root"), '
  const start = html.lastIndexOf(call)
  const end = html.indexOf(");\n</script>", start)
  if (start < 0 || end < 0) return html
  const env = `{location:{href:${JSON.stringify(href)}},fetch:function(input,init){return fetch(new URL(typeof input==="string"?input:input.url||String(input),${JSON.stringify(href)}),init)}}`
  return `${html.slice(0, end)}, ${env}${html.slice(end)}`
}

/** A `page` story of a served admin document: `setup` returns the emulator and the page's address. */
export function served(
  setup: () => Promise<{ emulator: Emulator; url: string }>,
  ready?: string,
): StoryObj {
  return {
    loaders: [
      async () => {
        const { emulator, url } = await setup()
        const response = await emulator.fetch(new Request(url))
        return { emulator, url, html: servedDocument(await response.text(), url) }
      },
    ],
    render: (_args, context) => {
      const { emulator, url, html } = context.loaded as {
        emulator: Emulator
        url: string
        html: string
      }
      return frame(html, { url, emulator })
    },
    ...(ready
      ? {
          play: async ({ canvasElement }) => {
            const doc = await frameDocument(canvasElement)
            await shows(doc.body, ready)
          },
        }
      : {}),
  }
}
