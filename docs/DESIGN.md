# Design

Mockingbird is a developer toolkit for local API and database emulation. Its documentation
uses neutral surfaces, clear navigation, technical examples, and explicit coverage. The
project name stays Mockingbird; describe each service as an **emulator**.

## Product language

**Local emulators. Real API contracts.**

The shared description is: "Run the APIs and databases your application depends on, inside
your own process. Deterministic state, vendor-compatible requests, and explicit coverage."

The tagline, description, and package epigraph live in `sites/docs/src/lib/content.ts`.
Run `bun run readme:sync` and `bun run llms:sync` after changing shared copy. Each published
package README includes `EPIGRAPH` verbatim; `pack:check` validates it.

Use **emulator** for a service, **emulate** for its behavior, and **emulation** for the process.
Describe the vendor interface, supported operations, state, controls, and parity evidence.
Keep coverage claims precise: self-parity establishes reproducibility; vendor fidelity requires
an oracle. Package names, CLI commands, environment variables, and existing API identifiers
remain compatible with consumers.

## Mark

The project icon is the black bird emoji **🐦‍⬛**, defined as `IDENTITY.icon` in
`sites/docs/src/lib/content.ts`. The shared `Logo` and `Brand` components render the native emoji in every top
bar, footer and single-purpose page; the generated README uses the same emoji in its title.

`sites/docs/public/identity/mockingbird.svg` contains the emoji for the favicon.
`MARK_REPO_PATH` and `MARK_HREF` identify that asset, and `check:readme` requires it to exist.
Keep the interface focused on developer documentation: code, API routes, diagrams, and runtime state.

Link previews (X, Slack, iMessage, LinkedIn) show `sites/docs/public/identity/social-card.png`,
described by `SOCIAL_CARD`. X does not render SVG, so the card is a 1200×630 PNG: a screenshot of
`/identity/social-card`, which draws it from the shared copy. Retake the screenshot when the
headline or mark changes. X overlays the page title on the card's bottom-left corner, so that
corner stays empty.

## Color

Every Mockingbird UI (this site, the admin, Fleet Cloud, the example apps and the pages
emulators serve) is React and [HeroUI v3](https://heroui.com) on one theme,
`packages/ui/src/tokens.css`, so they read as one product. Style with its tokens, never raw
colors:

| Token | Light | Dark | Role |
| --- | --- | --- | --- |
| `--background` | `#f6f8fa` | `#0d1117` | Page background |
| `--surface` | `#ffffff` | `#161b22` | Cards, tables and code |
| `--surface-secondary` | `#f6f8fa` | `#1c2128` | Toolbars, table headers and code panels |
| `--default` | `#eaeef2` | `#21262d` | Hover and selection surfaces, neutral chips |
| `--foreground` | `#1f2328` | `#f0f6fc` | Primary text |
| `--muted` | `#59636e` | `#9da7b3` | Secondary labels |
| `--border` | `#d8dee4` | `#30363d` | Panel and table dividers |
| `--accent` | `#2563eb` | `#58a6ff` | Actions, links, focus and the current page |

Success, warning and danger have their own tokens; `StatusChip` is the one mapping from a
status to its color.
The system, light, and dark theme options share the same component hierarchy. System is
the default; explicit choices persist in `mb:theme`. The page scrollbar remains visible
to keep the content width stable between pages.

The README license badge uses `2563eb`.

## Typography

Headings and interface text use the system sans-serif stack. Code, file paths, API routes,
and technical labels use the system monospace stack. No external fonts are required.
Use clear sentence-case headings, readable line lengths, and restrained emphasis.

## Components

Syntax highlighting uses the same Shiki grammars and light/dark themes for the hero,
installation commands, quick start, application examples, and Markdown code blocks.
Dynamic SQL and JSON views use the lightweight browser highlighters.

The quick start presents a connected checkout through Data → API → Client tabs. Its source
modules live in `sites/docs/src/lib/quick-start.ts`; the docs build executes those exact modules
against PostgreSQL and Stripe and verifies the confirmed payment and persisted order.

Featured emulators declare `mockingbird.featured: true` in their package manifest. A star marks
them on the homepage, docs index, catalog, service pages, guide navigation, and search palette.
The catalog's Featured filter is shareable as `/services?featured=1`, and `catalog.json`
includes the boolean. Featured status is an editorial selection, separate from coverage or parity.

Use a single border around panels, tables, and code samples: HeroUI's Card, Table and the
shared `CodeBlock` draw it. Corners derive from one 6px base radius. Overlays (the search, menus,
dialogs) carry the only shadows.

Code panels show filenames or routes. Runtime diagrams show the application, emulator,
and vendor boundaries. Coverage and state indicators use text labels alongside color.
Keep forms, navigation, search, and dialogs usable by keyboard. Honor reduced-motion
preferences and provide accessible labels for icon controls.

Pages are read inside in-app browsers on phones, so nothing may widen the page: wide tables and
code scroll inside their own panel. On a phone the top bar's section links scroll in their own row
under the brand. Text fields render at 16px on touch devices, because iOS
zooms the page when a focused field is smaller.

Every surface starts from `packages/ui` (`@crvouga/mockingbird-ui`): its README lists the shared
React components (`AppShell`, `PageHeader`, `CodeBlock`, `StatusChip`, …) and the rules. Only a
page that imitates another product's UI (Stripe Checkout, a vendor's own screen) breaks from it.

## Documentation surfaces

| Surface | Source and requirements |
| --- | --- |
| Docs site | React components in `sites/docs/src/ui` on the shared theme; live examples at `/identity` |
| GitHub README | Generated by `scripts/readme.ts` from shared copy, package licenses, and guides |
| Agent index | `scripts/llms-txt.ts` generates `llms.txt` from shared copy and package metadata |
| npm package guides | The common epigraph, followed by the emulator's integration guide |
| Service pages | The package README, operation coverage, and interactive runtime tools |
| Design guide | This file, also rendered at `/docs/design` |

## Adding a page

Write the page as React components in `sites/docs/src/ui` (HeroUI, the shared components, and
the site's own in `src/ui/primitives.tsx`) and compose them in an `.astro` page inside `Base`.
Components render to HTML at build time; add `client:load` or `client:visible` only to one that
needs JavaScript. `Base` writes the canonical URL and the Open Graph and X card tags from `title`
and `description`, so give every page both; pass `type="article"` for a guide and `noindex` for a
page that should not be shared or indexed.
Build layouts with the theme's tokens and Tailwind's layout utilities. Describe behavior in emulator terminology and
link to the relevant package guide or coverage evidence. Document any new token here.
