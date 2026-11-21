# @crvouga/mockingbird-ui

> Local emulators. Real API contracts. Part of [Mockingbird](https://github.com/crvouga-organization/mockingbird).

## Install

```sh
npm install @crvouga/mockingbird-ui
```

## Usage

Install `@crvouga/mockingbird-ui` to reuse the framework-independent preview shell. The package ships JavaScript and TypeScript declarations; no workspace source paths are required.

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

Switching preserves mounted surfaces. Failed mounts expose retry; destroying the shell aborts pending mounts and disposes both current and late-resolving surfaces. Surface IDs must be unique and cannot be `system`. URL synchronization is opt-in through `syncUrl`.

Application entrypoints, seeds, routing and credentials belong to the consumer. This shell supplies presentation and lifecycle only; it does not isolate untrusted code or protect secrets.

The root export also provides `CSS_RESET` and `scopeReset`. Bundlers may import `@crvouga/mockingbird-ui/reset.css` as a stylesheet.

The built-in System screen lists every surface, System included, in the order the switcher's arrows go through them. Each row shows the surface's `icon` and optional `description`, an Open button, and a switch for whether the arrows stop there; clicking anywhere on the row flips it. Drag a row by its grip, or focus the grip and use the arrow keys, Home and End, to reorder. The order persists under `ORDER_KEY`, the ids left out under `ROTATION_KEY`, and the pill's position too, all in `localStorage`, so a reload keeps them. An `icon` is inline SVG (`{ svg }`, trusted markup from your code), an image (`{ src }`), or a site's favicon (`{ favicon: url }`, trying `/favicon.ico` then `/apple-touch-icon.png`). Anything that fails to load falls back to the label's first letter, and no third-party icon service is asked. `SYSTEM_ICONS` has Mockingbird's own icons for `system`, `emulators` and `notifications`. Pass `services` (a `SystemServices`, such as `createDevResources(...).controls(...)` from `@crvouga/mockingbird-preview`) to list each emulated service with an Emulated | Dev switch, which sends its requests to a real non-production resource (a vendor's test mode or sandbox, a dev instance) through the dev proxy, plus a read-only Dev proxy status card (the proxy runs on the app's own origin and adds non-production credentials server-side, so the browser never sees one); services the proxy blocks show the host's reason and cannot be switched. Pass `docsUrl` for a "How dev resources work" link.

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

- `mountSystemHarness`: mounts lazy application surfaces and manages switching and teardown.
- `SystemSurface`, `SystemHarness`, `SystemHarnessOptions`: TypeScript lifecycle contracts.
- `SystemServices`, `SystemService`, `SystemServiceMode`, `SystemDevStatus`: what the System screen lists and switches.
- `SystemBuild`, `SystemBuildState`: a live preview's build, checks, connection and pending update, and the actions on it (`applyUpdate`, `postpone`, `setAutoUpdate`), for the switcher's status dot, the update toast and System's Preview card.
- `SystemIcon`, `SYSTEM_ICONS`: a surface's icon, and Mockingbird's icons for the surfaces it provides.
- `ROTATION_KEY`, `ORDER_KEY`, `INCLUDED_KEY`: the localStorage keys of the surfaces left out of the switcher, of its order, and of the off-by-default surfaces switched on.
- `defineSystem`, `mountSystem`, `PreviewApp`, `PreviewSystem`, `PreviewRegistryError`: the app registry and the shell it mounts.
- `systemSurfaces`, `planPartUpdate`, `PreviewLoadManifestLike`: the registry as surfaces with their part loader, and what a newer load manifest takes to apply.
- `PREVIEW_FRAME_CONNECT`: the type of the message an iframe app receives with its bridge port.
- `SystemHarness.update`, `SystemHarness.notify`, `SystemNotice`: swap one surface's code in place; show a notice over the apps.
- `SystemBackends`, `SystemBackend`: the in-tab backends and emulators for the System screen's Backends list.
- `CSS_RESET`: stylesheet string for a document.
- `scopeReset`: scopes the reset to a widget.
- `@crvouga/mockingbird-ui/reset.css`: stylesheet asset for bundlers.
