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
