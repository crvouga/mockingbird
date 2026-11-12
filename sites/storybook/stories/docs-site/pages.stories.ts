import type { Meta, StoryObj } from "@storybook/html-vite"

/**
 * The docs site (`sites/docs`, Astro): every page and page template, framed from the site itself.
 * Published, this catalog lives at `/storybook/` inside the docs site, so the frames load the real
 * pages from the same origin. Under `storybook dev` they load `bun run --cwd sites/docs dev`
 * (http://localhost:4321; `STORYBOOK_DOCS_URL` overrides it). Astro components render only
 * inside Astro, so a component is catalogued through the page and section that shows it.
 */
export default {
  title: "Docs site/Pages",
  parameters: {
    layout: "fullscreen",
    sources: [
      "sites/docs/src/pages/index.astro",
      "sites/docs/src/pages/why.astro",
      "sites/docs/src/pages/coverage.astro",
      "sites/docs/src/pages/identity.astro",
      "sites/docs/src/pages/identity/social-card.astro",
      "sites/docs/src/pages/404.astro",
      "sites/docs/src/pages/docs/index.astro",
      "sites/docs/src/pages/docs/[...slug].astro",
      "sites/docs/src/pages/services/index.astro",
      "sites/docs/src/pages/services/[name].astro",
      "sites/docs/src/pages/examples/index.astro",
      "sites/docs/src/pages/examples/medical-testing.astro",
      "sites/docs/src/layouts/Base.astro",
    ],
  },
} satisfies Meta

const DOCS = (
  import.meta.env.STORYBOOK_DOCS_URL ?? (import.meta.env.DEV ? "http://localhost:4321" : "")
).replace(/\/$/, "")

/** `docs/GETTING_STARTED.md` → `getting-started`, as the docs site names its guides. */
const GUIDES = Object.keys(import.meta.glob("../../../../docs/*.md"))
  .map((path) =>
    (path.split("/").pop() ?? "").replace(/\.md$/, "").toLowerCase().replace(/_/g, "-"),
  )
  .sort()

const SERVICES = Object.keys(import.meta.glob("../../../../packages/service/*/README.md"))
  .map((path) => path.split("/").at(-2) ?? "")
  .sort()

/** The docs site at `path`, in a frame that grows to the page when it can measure it. */
function site(path: string): HTMLElement {
  const iframe = document.createElement("iframe")
  iframe.title = `Docs site ${path}`
  iframe.src = `${DOCS}${path}`
  iframe.style.cssText = `display:block;width:100%;border:0;height:${Math.max(window.innerHeight, 600)}px`
  iframe.addEventListener("load", () => {
    try {
      const doc = iframe.contentDocument
      if (!doc) return
      const grow = () => {
        iframe.style.height = `${Math.max(window.innerHeight, doc.documentElement.scrollHeight)}px`
      }
      grow()
      new ResizeObserver(grow).observe(doc.documentElement)
    } catch {
      // Another origin (the Astro dev server): the frame keeps the canvas height and scrolls.
    }
  })
  return iframe
}

const at = (path: string): StoryObj => ({ render: () => site(path) })

export const Home: StoryObj = at("/")
export const QuickStartSection: StoryObj = at("/#quick-start")
export const InProcessSection: StoryObj = at("/#in-process")
export const AdminControlsSection: StoryObj = at("/#admin-controls")
export const NotificationsSection: StoryObj = at("/#notifications")
export const Why: StoryObj = at("/why")
export const Coverage: StoryObj = at("/coverage")
export const Identity: StoryObj = at("/identity")
export const SocialCard: StoryObj = at("/identity/social-card")
/** Tagged `expect-404`: `verify` lets the page's own 404 status through. */
export const NotFound: StoryObj = { ...at("/this-page-does-not-exist"), tags: ["expect-404"] }
export const Guides: StoryObj = at("/docs")

/** A guide (`docs/*.md` rendered by `docs/[...slug].astro`); pick any guide in Controls. */
export const Guide: StoryObj<{ guide: string }> = {
  args: { guide: GUIDES.includes("getting-started") ? "getting-started" : (GUIDES[0] ?? "") },
  argTypes: { guide: { control: "select", options: GUIDES } },
  render: ({ guide }) => site(`/docs/${guide}`),
}

export const Services: StoryObj = at("/services")

/** A service's page (`services/[name].astro`); pick any emulator in Controls. */
export const Service: StoryObj<{ service: string }> = {
  args: { service: "stripe" },
  argTypes: { service: { control: "select", options: SERVICES } },
  render: ({ service }) => site(`/services/${service}`),
}

/** An infrastructure emulator's page, which adds the in-browser SQL console. */
export const SqlService: StoryObj = at("/services/postgres")

export const Examples: StoryObj = at("/examples")
export const MedicalTestingExample: StoryObj = at("/examples/medical-testing")

export const HomeOnAPhone: StoryObj = {
  ...at("/"),
  globals: { viewport: { value: "phone", isRotated: false } },
}
