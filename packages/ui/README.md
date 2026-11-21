# @crvouga/mockingbird-ui

> Local emulators. Real API contracts. Part of [Mockingbird](https://github.com/crvouga/mockingbird).

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

The built-in System screen lists every surface as a card (its optional `description`, an Open button and an "In switcher" toggle; ids left out of the arrows persist under `ROTATION_KEY`). Pass `services` (a `SystemServices`, such as `createSandbox(...).controls(...)` from `@crvouga/mockingbird-preview`) to list each emulated service with an Emulated | Sandbox switch and a sandbox access panel, and `docsUrl` for a "How sandbox mode works" link.

## API

- `mountSystemHarness`: mounts lazy application surfaces and manages switching and teardown.
- `SystemSurface`, `SystemHarness`, `SystemHarnessOptions`: TypeScript lifecycle contracts.
- `SystemServices`, `SystemService`, `SystemServiceMode`, `SystemSandboxStatus`: what the System screen lists and switches.
- `ROTATION_KEY`: the localStorage key of the surfaces left out of the switcher.
- `CSS_RESET`: stylesheet string for a document.
- `scopeReset`: scopes the reset to a widget.
- `@crvouga/mockingbird-ui/reset.css`: stylesheet asset for bundlers.
