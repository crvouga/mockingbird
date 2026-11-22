# @crvouga/mockingbird-ui

> Local emulators. Real API contracts. Part of [Mockingbird](https://github.com/crvouga-organization/mockingbird).

## Install

```sh
npm install @crvouga/mockingbird-ui
```

## Usage

The design system: every Mockingbird UI (the admin, the System harness, Fleet Cloud, the notifications harness, the docs site, the example apps and the pages emulators serve) is React and [HeroUI v3](https://heroui.com/docs/react/getting-started), themed once here, so they all read as one product. Only a page that imitates another product (Stripe Checkout, a vendor's own screen) breaks from it.

The rules:

- **Prefer HeroUI.** Import `Button`, `Card`, `Table`, `Tabs`, `TextField`, `Modal`, `Alert`, `Chip`, … from `@heroui/react` directly (compound parts: `Card.Header`, `Table.Row`; events: `onPress`). Icons come from `@gravity-ui/icons`, the set HeroUI's docs use.
- **Use the shared components** below for the patterns every surface repeats; do not rebuild a top bar, a page header, an empty or error state, a code block or a status chip.
- **Style with the theme's tokens**, never raw colors: `bg-background`, `bg-surface`, `text-foreground`, `text-muted`, `border-border`, `bg-accent`, `text-danger`, … They follow light and dark on their own, so `dark:` variants are not needed.
- **Put utility classes in `.tsx` files.** The precompiled stylesheet only scans `.tsx`.

### Theme

`src/tokens.css` sets HeroUI's tokens to the docs site's identity (`docs/DESIGN.md`): neutral GitHub-like surfaces (`#f6f8fa` / `#0d1117` page, white / `#161b22` cards), blue `#2563eb` / `#58a6ff` for actions, links, focus and the current page, green, amber and pink-red for status, a 1px border ring on cards, bordered fields, a 6px base radius, and the system sans and mono font stacks (no web fonts). The mark is the 🐦‍⬛ emoji (`MOCKINGBIRD.icon`).

Light and dark follow the system preference by default. `class="dark"` or `data-theme="dark"` (or `light`) on `<html>`, or on any element, pins that subtree: the switch HeroUI itself reads. `ThemeSwitch` (or `renderDocument({ rememberTheme: true })`) stores the visitor's choice under `mb:theme`, the key the docs site uses.

### Stylesheets

| Import | What |
| --- | --- |
| `@crvouga/mockingbird-ui/styles.css` | Precompiled: Tailwind CSS v4 + HeroUI + the theme, with every utility the `.tsx` files of the Mockingbird surfaces use (see `src/stylesheet.css`). For bundlers and `<link>`. |
| `@crvouga/mockingbird-ui/styles` | The same as a string, `MOCKINGBIRD_CSS`, for pages that inline it. |
| `@crvouga/mockingbird-ui/theme.css` | The source, for a consumer with its own Tailwind v4 pipeline (the docs site, through `@tailwindcss/vite`): `@import "@crvouga/mockingbird-ui/theme.css"; @source "../";` |
| `@crvouga/mockingbird-ui/tokens.css` | Only the tokens (plain CSS custom properties). |

A surface that adds a UI directory adds an `@source` line to `src/stylesheet.css` and the same glob to `turbo.json`'s build inputs.

### Shared React components

From `@crvouga/mockingbird-ui/react` (peer dependencies: `react`, `react-dom`, `@heroui/react`, `@gravity-ui/icons`):

| Component | Props |
| --- | --- |
| `MockingbirdProvider` | `theme?: "system" \| "light" \| "dark"`, `locale?`, `navigate?(href)` (client-side routing for HeroUI links), `className?`. One per React root; `mount` and `renderPage` add it. |
| `AppShell` | `product?`, `brandHref?`, `nav?: { label, href, current?, icon? }[]`, `actions?`, `fluid?`, `footer?`, `mainProps?` (attributes for its `<main>`), `children`. Sticky top bar with the brand; nav scrolls in its own row on a phone. |
| `PageHeader` | `title`, `description?`, `actions?`, `eyebrow?`, `level?: 1 \| 2` |
| `CenteredCard` | `title`, `description?`, `children`, `footer?`, `product?`, `notice?`, `size?: "sm" \| "md" \| "lg"`. Sign-in, consent, pairing and error pages: the brand over one card; the title is the page's `h1`. |
| `EmptyState` | `title`, `description?`, `icon?`, `action?` |
| `ErrorState` | `title?`, `error?: unknown`, `onRetry?`, `retryLabel?` |
| `LoadingState` | `label?` |
| `CodeBlock` | `code`, `label?`, `language?`, `copyable?`, `copyLabel?` (the copy button's name), `actions?` (more buttons beside it), `maxHeight?`, `wrap?`. The copy button appears once the page has JavaScript. |
| `JsonView` | `value`, plus `CodeBlock`'s `label`, `copyable`, `maxHeight`, `wrap` |
| `KeyValueList` | `items: { label, value, mono?, id? }[]` (a `<dl>`, two columns, stacked on a phone) |
| `StatusChip` | `status: "ok" \| "warning" \| "error" \| "info" \| "neutral"`, `children`, `size?`, `dot?`. The one mapping from meaning to color. |
| `Brand`, `Logo` | `product?`, `href?`, `size?` / `size?` |
| `ThemeSwitch`, `useMockingbirdTheme()` | Light / dark / system, for `AppShell`'s `actions`. |

`MOCKINGBIRD` (name, icon, tagline, docs and repo URLs) is exported from here and from the root.

TypeScript: HeroUI's declarations use extensionless imports, so a package that imports `@heroui/react` sets `"module": "ESNext", "moduleResolution": "Bundler", "jsx": "react-jsx"` in its tsconfig (the surface packages already do).

### A client-side surface (SPA)

```tsx
import { AppShell, PageHeader, StatusChip, ThemeSwitch } from "@crvouga/mockingbird-ui/react"
import { mount } from "@crvouga/mockingbird-ui/react/client"
import "@crvouga/mockingbird-ui/styles.css" // or <link> it, or inline MOCKINGBIRD_CSS
import { Button } from "@heroui/react"

function App() {
  return (
    <AppShell product="Fleet Cloud" nav={[{ label: "Fleets", href: "/", current: true }]} actions={<ThemeSwitch />}>
      <PageHeader title="Fleets" actions={<Button onPress={() => {}}>New fleet</Button>} />
      <StatusChip status="ok">Running</StatusChip>
    </AppShell>
  )
}
mount(document.getElementById("root") as HTMLElement, <App />)
```

`mount(container, element, { theme?, locale?, navigate? })` wraps the element in `MockingbirdProvider`, and hydrates instead of rendering when the container is a server-rendered page's root (`[data-mockingbird-root]`, from `renderPage`) that already holds its markup; any other container is rendered into fresh.

### Pages served as strings (portable runtimes)

An emulator serves its pages as strings from a runtime that must stay portable (Node, Bun, Deno, Workers, browsers) and must not load React on its hot path. The pattern: **render on the server with React, inside a prebuilt module the runtime imports lazily**. The page is complete HTML: forms post natively without JavaScript, so tests that post forms, and Storybook `page()` stories that route posts back to the emulator, keep working. Hydrate only a page that needs interactivity.

1. Write the page as components, and a server entry that renders it with `renderPage`:

   ```tsx
   // src/ui/server.tsx
   import { CenteredCard } from "@crvouga/mockingbird-ui/react"
   import { renderPage } from "@crvouga/mockingbird-ui/react/server"
   import { MOCKINGBIRD_CSS } from "@crvouga/mockingbird-ui/styles"
   import { Button } from "@heroui/react"

   export function consentPage(props: { client: string; action: string }): string {
     return renderPage(
       <CenteredCard product="Google" title={`Allow ${props.client}?`}>
         <form method="post" action={props.action}><Button type="submit" fullWidth>Allow</Button></form>
       </CenteredCard>,
       { title: "Consent", css: MOCKINGBIRD_CSS },
     )
   }
   ```

2. Prebuild it in the package's `build` (before its own bundling), and map it with a package `imports` entry: tests and type checks read the source, everything else the prebuilt module:

   ```jsonc
   // package.json
   "scripts": { "build": "bun ../../../packages/ui/scripts/bundle.ts --ssr src/ui/server.tsx && bun ../../../scripts/bundle-service.ts" },
   "imports": {
     "#ui/server": { "types": "./src/ui/server.tsx", "bun": "./src/ui/server.tsx", "default": "./dist-ui/server.js" }
   }
   ```

   `scripts/bundle.ts --ssr` writes `dist-ui/server.js`: the entry with React, `react-dom/server`, HeroUI and the shared components as one minified ES module with no Node API, no `process` and no CommonJS, so it passes `bun run portability`, and with the license notices inside. `@crvouga/mockingbird-ui/styles` stays an import (one copy of the CSS per install), so the package lists `@crvouga/mockingbird-ui` in `dependencies`; React and HeroUI are build-time only (`devDependencies` in a published package). `dist-ui/` is gitignored and a turbo build output.

3. Load it lazily where the page is served:

   ```ts
   app.get("/consent", async (c) => {
     const { consentPage } = await import("#ui/server")
     return c.html(consentPage({ client: "Acme", action: "/consent" }))
   })
   ```

   `scripts/bundle-service.ts` keeps it in a chunk of its own, so `createRuntime().fetch` never parses it until the page is requested.

4. Only if the page needs JavaScript (copy buttons, live updates, client-side validation): a client entry, bundled into a string, and passed to `renderPage` to hydrate the same element with the same props:

   ```tsx
   // src/ui/client.tsx: the IIFE assigns these exports to the --global name
   import { mount } from "@crvouga/mockingbird-ui/react/client"
   export const mountInspector = (root: HTMLElement, props: InspectorProps) => mount(root, <Inspector {...props} />)
   ```

   `bun ../../../packages/ui/scripts/bundle.ts --ssr src/ui/server.tsx --client src/ui/client.tsx --global MockingbirdOAuth` adds `dist-ui/client.bundle.js` (`export const BUNDLE: string`). Map it with `"#ui/client-bundle": { "types": "./src/ui/client-bundle.d.ts", "default": "./dist-ui/client.bundle.js" }` (a committed one-line `export declare const BUNDLE: string`), import it lazily beside the server module, and pass `script: { source: BUNDLE, call: "MockingbirdOAuth.mountInspector", props }` to `renderPage`.

`@crvouga/mockingbird-ui/document` is the framework-free half, safe on any request path: `renderDocument({ title, css, body?, head?, script?, theme?, rememberTheme?, lang?, rootId?, nonce? })` returns the `<!doctype html>` document (viewport, color scheme, `<title>… · Mockingbird`, the bird favicon, the stylesheet, a root `<div id="root">`, the bundle and its start call with JSON props escaped for `<script>`), plus `escapeHtml`, `scriptJson` and `scriptSource`. `renderPage(element, options)` from `@crvouga/mockingbird-ui/react/server` is `renderDocument` with `body` rendered by `renderToString`; `renderToHtml(element)` renders a fragment.

### The docs site (Astro)

`sites/docs` has `@astrojs/react` and `@tailwindcss/vite` wired in `astro.config.ts`. Compile the theme with the site's own markup as a source, and render the shared components as islands:

```css
/* src/styles/app.css */
@import "@crvouga/mockingbird-ui/theme.css";
@source "../";
```

```astro
---
import "../styles/app.css"
import { PageHeader, StatusChip } from "@crvouga/mockingbird-ui/react"
---
<PageHeader title="Emulators" description="Every API Mockingbird emulates." />
<StatusChip status="ok">Featured</StatusChip>
```

A component with no client directive renders to HTML only; add `client:load` (or `client:visible`) to one that needs JavaScript, inside a `MockingbirdProvider`.

### Catalog

Storybook's `Admin/Design system/Components` (`sites/storybook/stories/admin/design-system`) draws every shared component both ways: server-rendered with `renderPage` (system, light, dark, phone, and a centered form) and hydrated with `mount`.

### System preview shell

Install `@crvouga/mockingbird-ui` to reuse the preview shell. Its API is framework-independent (plain DOM elements and callbacks); its UI is React and HeroUI like every other Mockingbird surface, prebuilt into `dist/system-view.js` with React and HeroUI inside, so a host app needs neither installed. The package ships JavaScript and TypeScript declarations; no workspace source paths are required.

```ts
import { mountSystemHarness, type SystemSurface } from "@crvouga/mockingbird-ui/system"

const surfaces: SystemSurface[] = [{
  id: "example",
  label: "Example app",
  mount(host, signal) {
    host.textContent = "Application content"
    signal.throwIfAborted()
    return () => { host.replaceChildren() }
  },
}]
const host = document.createElement("div")
document.body.append(host)
const harness = mountSystemHarness(host, surfaces, { initial: "example" })
await harness.show("example")
harness.destroy()
```

Switching preserves mounted surfaces. Failed mounts expose retry; destroying the shell aborts pending mounts and disposes both current and late-resolving surfaces. Surface IDs must be unique and cannot be `system`. URL synchronization is opt-in through `syncUrl` (or `url`, below).

#### Lifecycle, host URLs and preferences

```ts
const harness = mountSystemHarness(host, [{
  id: "call",
  label: "Video call",
  mount: (panel) => startCall(panel),        // returns its disposer
  onHide: () => stream.getTracks().forEach((track) => track.stop()),
  onShow: () => restartTracksIfStopped(),
}], {
  evictHiddenAfterMs: 5 * 60_000,             // unmount surfaces hidden for five minutes
  onShow: (id) => analytics.track("surface", id),
  url: {                                      // each surface owns one of the host's paths
    read: (location) => surfaceForPath(location.pathname),
    write: (id) => pathForSurface(id),
  },
  storage: shellStore,                        // a store the apps never clear on sign-out
  defaultExcluded: ["partner"],
})
```

- **`onShow()` / `onHide()` on a surface** follow whether it is visible: a switch to or away from it, and its browser tab going to the background or coming back (`visibilitychange`). They alternate, starting with `onShow` right after its mount resolves (on every mount, so a surface shown, hidden and shown again before its mount resolves gets one `onShow`). A disposed surface (by `update()`, eviction or `destroy()`) gets no `onHide`; its disposer releases everything. Use them to pause polling or release a microphone or WebRTC room while hidden.
- **`evictHiddenAfterMs`** unmounts a surface hidden that long: its signal aborts, its disposer runs and its panel empties. Showing it again mounts it afresh, with the usual Retry if that fails. Showing it before the time is up cancels the eviction. System is never evicted. Default: never.
- **`onShow(id)` in the options** tells the host the shown surface changed (`"system"` for System), whether by `show()`, the pill's arrows, a System row's Open or back/forward. It is called once per change, synchronously, after the address bar is written and **before** the surface's mount resolves. It is not called for the surface shown when the harness mounts (read `active()`), nor when the shown surface is shown again.
- **`url: { read, write }`** maps surfaces to the host's own URLs instead of `syncUrl`'s `?surface=` and `route`s, and turns URL sync on. `read(location)` names the surface an address opens (`undefined` means `initial`); it runs on mount and on back/forward. After a switch, when `read` says the current address opens another surface, `write(id, location)` returns the new address (absolute or relative), which is pushed onto history; `undefined` leaves the address bar. A deep link into a surface (`/care-hub/patients/7`) is therefore left as it is.
- **`storage`** is where the switcher's preferences live: `ROTATION_KEY`, `INCLUDED_KEY`, `ORDER_KEY` and the pill's position (`DOCK_KEY`). It defaults to `localStorage`, which a same-origin app may clear on sign-out, resetting the shell; pass any `{ getItem, setItem }` (a cookie, a namespaced store the apps never clear) and nothing is written to `localStorage`. (The theme the System screen's switch picks is Mockingbird's origin-wide `mb:theme` and stays in `localStorage`.)
- **`defaultExcluded`** leaves surfaces out of the switcher until a person switches them on, as a surface's `defaultEnabled: false` does; use it instead of seeding `ROTATION_KEY`. A missing or cleared store means these defaults, not everything on.

Each surface mounts into its own panel, `section[data-surface="<id>"]` (the one shown is the one without `hidden`), and its content there is styled by the host page alone. The shell's own UI (the switcher pill, its tooltip and update toast, each panel's loading and error state, and the System screen) loads lazily on mount, so importing the module costs no React; `show()` settles once that UI has drawn. It uses Mockingbird's stylesheet scoped to its own containers (`.msh-ui`, every selector wrapped in `:where(.msh-ui)`, added to the document once as `<style id="mockingbird-system-ui">`), so Preflight and HeroUI's classes restyle nothing else on the page; only the stylesheet's `@keyframes` and `@property` registrations are global. It follows a light or dark theme pinned on `<html>` (`class` or `data-theme`, as the System screen's theme switch sets it), else the system's. The test hooks: `data-testid` `system-switcher` (with `system-switcher-previous` and `-next`), `system-build-dot`, `system-update-toast`, `system-preview` (its rows `[data-row]`), `system-dev-proxy`, `system-services-summary`, the service rows `[data-service]` (`data-mode`, `data-pending`), and the app rows `ol.msh-apps > li[data-app]`.

Application entrypoints, seeds, routing and credentials belong to the consumer. This shell supplies presentation and lifecycle only; it does not isolate untrusted code or protect secrets.

The root export also provides `CSS_RESET` and `scopeReset`. Bundlers may import `@crvouga/mockingbird-ui/reset.css` as a stylesheet.

The built-in System screen is an `AppShell` (with `ThemeSwitch`) and a `PageHeader`, and lists every surface, System included, in the order the switcher's arrows go through them. Each row (a HeroUI `Card`) shows the surface's `icon` and optional `description`, an Open button, and a HeroUI `Switch` for whether the arrows stop there; clicking anywhere on the row flips it. Drag a row by its grip, or focus the grip and use the arrow keys, Home and End, to reorder. The order persists under `ORDER_KEY`, the ids left out under `ROTATION_KEY`, and the pill's position under `DOCK_KEY`, all in `localStorage` (or the `storage` option), so a reload keeps them. An `icon` is inline SVG (`{ svg }`, trusted markup from your code), an image (`{ src }`), or a site's favicon (`{ favicon: url }`, trying `/favicon.ico` then `/apple-touch-icon.png`). Anything that fails to load falls back to the label's first letter, and no third-party icon service is asked. `SYSTEM_ICONS` has Mockingbird's own icons for `system`, `emulators` and `notifications`. Pass `services` (a `SystemServices`, such as `createDevResources(...).controls(...)` from `@crvouga/mockingbird-preview`) to list each emulated service with an Emulated | Dev switch (a HeroUI `ToggleButtonGroup`; pressing either half, or an arrow key, flips it), which sends its requests to a real non-production resource (a vendor's test mode or sandbox, a dev instance) through the dev proxy, plus a read-only Dev proxy status card (the proxy runs on the app's own origin and adds non-production credentials server-side, so the browser never sees one); services the proxy blocks show the host's reason and cannot be switched. Pass `docsUrl` for a "How dev resources work" link.

Pass `build` (a `SystemBuild`, such as `createLivePreview(...)` from `@crvouga/mockingbird-preview`) on a live PR preview. The switcher pill gets a status dot in its corner, without changing its size: green when this tab is up to date (with a pulsing ring while the status socket is live), amber and spinning while a newer commit builds, blue when an update is ready, red when a build or update failed, grey when offline. The dot is a button labelled "Preview status: …"; hovering or focusing it shows the status, and clicking it opens System. While an update is available, a toast beside the pill (never over it) says "New version abc1234 ready · updating in 8s" with Update now and Not now, then "Updating…", or the error with Retry. The System screen gains a Preview card above Apps: this tab's version and age, the latest deployed version, the build and the CI checks with links to their runs, the connection, an Auto-update switch and Update now. Relative times tick in place (every second under a minute, then every 15 s), each a `<time>` with the absolute time as its title. Without `build`, none of this renders. Animations stop when the person prefers reduced motion.

```ts
import { mountSystemHarness, type SystemBuild, type SystemSurface } from "@crvouga/mockingbird-ui"

declare const host: HTMLElement
declare const surfaces: SystemSurface[]
declare const livePreview: SystemBuild // e.g. createLivePreview(...) from @crvouga/mockingbird-preview

mountSystemHarness(host, surfaces, { build: livePreview })
```

## App registry

Declare each app once with `defineSystem` and mount the registry with `mountSystem`. The switcher order, the System screen's Apps and Backends lists, the routes and the build's part list (`system.parts()`, which `buildPreviewParts` in `@crvouga/mockingbird-preview/node` turns into `parts.json`) all come from that one declaration, so adding an app is one more entry.

```ts
import { defineSystem, mountSystem } from "@crvouga/mockingbird-ui"

const system = defineSystem({
  apps: [
    { id: "member", label: "Member web", route: "/", part: { source: "apps/member/preview.ts" }, backends: ["api", "stripe"] },
    { id: "clinician", label: "Clinician web", route: "/clinician", part: { source: "apps/clinician/preview.ts", prefetch: true }, backends: ["api"] },
    { id: "partner", label: "Partner portal", route: "/partner", mount: "iframe", defaultEnabled: false, part: { source: "apps/partner/preview.ts" } },
  ],
  backends: [{ id: "api" }, { id: "stripe", kind: "emulator" }],
})

declare const host: HTMLElement
declare const manifest: import("@crvouga/mockingbird-ui").PreviewLoadManifestLike // parts.json
const preview = mountSystem(host, system, { manifest, syncUrl: true })
```

- **A `PreviewApp`** has `id`, `label`, optional `icon` and `description`, `defaultEnabled`, `route`, `part`, `backends`, `mount` (`"inline"`, the default, or `"iframe"`) and `health`. An inline part's module exports `mount(host, { app, route, version, signal })` and returns a disposer; `part.load` imports one from the shell's own bundle instead of a built entry.
- **`defineSystem` rejects a registry** that cannot work, with a `PreviewRegistryError` whose `code` says why: `duplicate_app`, `reserved_app` (`system`), `invalid_route`, `route_conflict` (two apps with the same route; `/` and `/clinician` do not conflict, the longest route wins), `unknown_backend` (when `backends` is declared), `invalid_part`. A build script that imports the registry fails on it.
- **Off by default.** `defaultEnabled: false` keeps an app out of the arrows' rotation until it is switched on in System. The choice is kept per browser under `INCLUDED_KEY`, beside `ROTATION_KEY`.
- **Routes.** With `syncUrl`, a deep link (`/clinician/patients/7`) opens the app that owns the path, apps without a route keep `?surface=`, and switching away and back restores each app's last path (in memory, for the tab). Routes are absolute paths on the page's origin.
- **Lazy loading.** An app's part and the backends it names (`ensureBackends`, such as `backendControls(...).ensure`) load on its first open; the shell's first paint costs the shell and that one app. Parts marked `prefetch` load at idle priority (`requestIdleCallback`) only after the first app is up. A part loads once per pin; a failed load shows Retry in that app only and is fetched again on retry.
- **Iframe apps** get their own document and globals. Each time the frame loads it receives a `MessagePort` (`PREVIEW_FRAME_CONNECT`) that the shell hands to `bridge`, so it reaches the same backends as inline apps; inside the frame, `acceptPreviewFrame()` from `@crvouga/mockingbird-preview` turns it into a `fetch`.
- **Updating one app in place.** `preview.applyManifest(next)` compares pins (`planPartUpdate`) and swaps only what changed: backends first through `replaceBackend`, then each changed app is disposed and mounted again with its new code while every other app keeps its DOM, scroll position and state. A change to the shared runtime (the `runtime` pin), or apps or backends added or removed, is refused with a notice that says why and offers Reload. A backend whose new code fails to boot leaves the old one serving and shows the error with Retry. Feed it from `followPartUpdates` for the dev loop, or from your freshness signal in a deployed preview.

`mountSystemHarness` keeps working with plain `SystemSurface`s; the registry's fields (`defaultEnabled`, `route`, `backends`, `version`, `health`) are optional there too, and `harness.update(id, next?)` and `harness.notify(notice)` are available on any harness.

## API

- `@crvouga/mockingbird-ui/react`, `/react/server`, `/react/client`, `/document`, `/styles`, `/styles.css`, `/theme.css`, `/tokens.css`: the design system, above.
- `MOCKINGBIRD`: the project's name, mark, tagline and URLs.
- `mountSystemHarness`: mounts lazy application surfaces and manages switching and teardown.
- `SystemSurface`, `SystemHarness`, `SystemHarnessOptions`: TypeScript lifecycle contracts (`onShow`/`onHide`, `evictHiddenAfterMs`, the host's `onShow(id)`, `url`, `storage`, `defaultExcluded`).
- `SystemHarnessUrl`, `SystemHarnessStorage`: the `url` mapping and the preferences store.
- `SystemServices`, `SystemService`, `SystemServiceMode`, `SystemDevStatus`: what the System screen lists and switches.
- `SystemBuild`, `SystemBuildState`: a live preview's build, checks, connection and pending update, and the actions on it (`applyUpdate`, `postpone`, `setAutoUpdate`), for the switcher's status dot, the update toast and System's Preview card.
- `SystemIcon`, `SYSTEM_ICONS`: a surface's icon, and Mockingbird's icons for the surfaces it provides.
- `ROTATION_KEY`, `ORDER_KEY`, `INCLUDED_KEY`, `DOCK_KEY`: the storage keys of the surfaces left out of the switcher, of its order, of the off-by-default surfaces switched on, and of the pill's position.
- `defineSystem`, `mountSystem`, `PreviewApp`, `PreviewSystem`, `PreviewRegistryError`: the app registry and the shell it mounts.
- `systemSurfaces`, `planPartUpdate`, `PreviewLoadManifestLike`: the registry as surfaces with their part loader, and what a newer load manifest takes to apply.
- `PREVIEW_FRAME_CONNECT`: the type of the message an iframe app receives with its bridge port.
- `SystemHarness.update`, `SystemHarness.notify`, `SystemNotice`: swap one surface's code in place; show a notice over the apps.
- `SystemBackends`, `SystemBackend`: the in-tab backends and emulators for the System screen's Backends list.
- `CSS_RESET`: stylesheet string for a document.
- `scopeReset`: scopes the reset to a widget.
- `@crvouga/mockingbird-ui/reset.css`: stylesheet asset for bundlers.
