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

## API

- `mountSystemHarness`: mounts lazy application surfaces and manages switching and teardown.
- `SystemSurface`, `SystemHarness`, `SystemHarnessOptions`: TypeScript lifecycle contracts.
- `SystemServices`, `SystemService`, `SystemServiceMode`, `SystemDevStatus`: what the System screen lists and switches.
- `SystemBuild`, `SystemBuildState`: a live preview's build, checks, connection and pending update, and the actions on it (`applyUpdate`, `postpone`, `setAutoUpdate`), for the switcher's status dot, the update toast and System's Preview card.
- `SystemIcon`, `SYSTEM_ICONS`: a surface's icon, and Mockingbird's icons for the surfaces it provides.
- `ROTATION_KEY`, `ORDER_KEY`: the localStorage keys of the surfaces left out of the switcher, and of its order.
- `CSS_RESET`: stylesheet string for a document.
- `scopeReset`: scopes the reset to a widget.
- `@crvouga/mockingbird-ui/reset.css`: stylesheet asset for bundlers.
