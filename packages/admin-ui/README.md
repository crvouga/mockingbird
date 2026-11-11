# Shared admin UI

React and Ant Design power the complete service admin shell: layout, menus, tables,
forms, dialogs, theme switching, and loading/error/success feedback. All structured
data uses Ant Design Table with bounded columns, horizontal scrolling, search,
sorting, pagination, and expandable JSON details.

`bun run build` compiles a production browser bundle and exports it as a string.
Service runtimes import that string without importing React or accessing the DOM.
Each published service bundles the document locally; administration works without
a CDN, in Bun, Node, a standalone browser page, or the docs example's Shadow DOM.
The bundle includes notices and license texts for its third-party dependencies.

The client calls the existing admin API through the document's scoped fetch.
`composeAdminApis` can mount any number of independent admin APIs behind one facade. The shell
then exposes a global emulator selector and sends every read or mutation only to the selected API;
it does not duplicate service state or implement service controls in the browser.
In a composed shell the top-left title is the emulator switcher. `Command/Ctrl + K` opens the
keyboard-first command palette for jumping directly to any emulator and built-in screen.
Ant Design's StyleProvider and ConfigProvider keep styles and portals within the
embedded document. Hosts dispatch `mockingbird:unmount` before detaching the document
to dispose the React root. Service-owned manifest panels keep their existing API
and can return a cleanup function from their script. Declarative `route` extensions
render service actions with the shared prebuilt request form and response viewer;
the built-in Plane action uses this instead of shipping a custom HTML form.

SQL engines use the same UI as HTTP services. SQL changes remain in the live
database. State writes, clock controls, latency, fault injection, snapshots, journals,
route execution, namespaces, keys, branches, and checkpoints retain their existing server
contracts.

Manual controls combines bounded delay, timeout and HTTP 503 actions with request targeting,
real/virtual waits, active rule removal, and a live filtered request journal. The journal groups
attempts by method, path and operation so a manual retry can be checked against received traffic.
The advanced Latency and Faults screens remain available for persistent and scheduled rules.

## Entry points

| Import | For | Exports |
| --- | --- | --- |
| `@crvouga/mockingbird-admin-ui` | A service runtime that serves the admin page as one HTML document | `adminClientScript`, `adminClientSource`, `membersClientSource`, `composeAdminApis`, `composeAdminRoutes` |
| `@crvouga/mockingbird-admin-ui/browser` | A page that bundles the UI as an ES module and mounts it into its own DOM | `mount`, `mountMembers`, types `AdminEnvironment`, `PanelScript` |
| `@crvouga/mockingbird-admin-ui/compose` | The routing for several admin APIs, without the browser bundle | `composeAdminRoutes`, types `ComposableAdminApi`, `ComposedAdminRoutes` |

### `./browser`: mount the UI in your own page

`mount(host, config, env?)` renders the admin shell into `host` and returns a function that
disposes it. `mountMembers(host, config, env?)` does the same for the members screen.

```ts
import { mount } from "@crvouga/mockingbird-admin-ui/browser"
import { composeAdminRoutes } from "@crvouga/mockingbird-admin-ui/compose"

const routes = composeAdminRoutes(apis, { brandsUrl: "/brands.json" })
const unmount = mount(document.querySelector("#admin"), routes.config, {
  // Answer admin requests in-process instead of over the network.
  fetch: (input, init) => routes.fetch(new Request(new URL(String(input), location.href), init)),
  // Keep the shell's ?emulator=, ?namespace= and #view off the page's own address.
  location: { href: "http://admin.local/__admin/ui" },
})
// later
unmount()
```

Every `AdminEnvironment` field is optional; the default is the document the UI is mounted in.

| Field | Replaces |
| --- | --- |
| `fetch` | The page's `fetch`, for every admin API and brand catalog request |
| `location` | The URL the UI reads `?emulator=`, `?namespace=`, `?admin_key=`, `?brands=` and `#view` from. With one, view changes stay in memory |
| `history` | Where the UI's URL updates go (`replaceState`) |
| `shortcutTarget` | Where Command/Ctrl + K is listened for (default `document`) |
| `viewport` | The box the UI fills (default the window, or the shadow host) |
| `styleContainer` | Where Ant Design's `<style>` elements go (default `document.head` or the shadow root) |
| `panelScript` | How a custom panel's script runs: `(panel, api) => PanelScript \| undefined`, or `false` for none |

The module never compiles a string, so it runs under a Content Security Policy without
`'unsafe-eval'`. A custom panel's `script` is therefore inactive unless `panelScript` returns a
real function for it; the panel still shows its markup, with a notice pointing at the emulator's
own admin page.

### `./compose`: one UI for several admin APIs

`composeAdminRoutes(apis, { brandsUrl, prefix? })` takes admin APIs (`id`, `service`,
`adminPrefix`, `adminKeyHeader`, `standardRoutes`, optional `label`, and a `fetch`) and returns:

- `config`: what `mount` takes, with one entry per API, each behind `<prefix>/apis/<id>`;
- `prefix`: the normalised mount prefix, `/__admin` by default;
- `fetch(request)`: forwards `<prefix>/apis/<id>/…` to that API unchanged, and answers 404 for
  anything else.

Ids are lowercase letters, digits and hyphens, and unique. This entry never imports the prebuilt
browser bundle, so a page that mounts the UI from `./browser` does not also carry it as a string.
`composeAdminApis` from the package root wraps the same routing and also serves the HTML document.
The fleet dashboard (`mockingbird-fleet serve --dashboard`) and the lab ordering example both show
every emulator's admin UI this way.
