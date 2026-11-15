# @crvouga/mockingbird-adapter-browser

> Local emulators. Real API contracts. Part of [Mockingbird](https://github.com/crvouga/mockingbird).

Run server-oriented JavaScript in static, browser-local system previews. This adapter supplies a
shared virtual filesystem and network plus a bundler configuration for Node standard-library
polyfills. It is an explicit compatibility layer, not a complete Node, Bun or Deno implementation.
Native executables and arbitrary server packages cannot all run through JavaScript polyfills.

## Install

```sh
npm install @crvouga/mockingbird-adapter-browser esbuild
```

## Usage

Build the runtime package, then use its configuration in your esbuild task:

```ts
import { build } from "esbuild"
import { browserRuntimeBuildOptions } from "@crvouga/mockingbird-adapter-browser/build"

await build({
  ...browserRuntimeBuildOptions(),
  entryPoints: ["src/preview.ts"],
  bundle: true,
  format: "esm",
  splitting: true,
  outdir: "preview-dist",
})
```

Your preview entry installs the runtime **before** importing server entrypoints:

```ts
import { installBrowserRuntime } from "@crvouga/mockingbird-adapter-browser"

const dispose = installBrowserRuntime()
const entrypoint = "./system.js"
await import(entrypoint)
// When the entire preview ends: dispose()
```

The lab's standalone preview uses this build configuration. Existing browser-compatible code
keeps its Fetch API contracts. The docs embed does not install globals into its parent page.

## API

- `browserRuntime`: the shared world used by bundled Node imports, Bun and Deno.
- `createBrowserRuntime({ env?, networkFetch? })`: an isolated world with `fs`, `net`, `env`,
  `bun`, `deno`, `fetch`, `mountAssets` and `dispose`. `mountAssets` accepts explicit absolute
  virtual paths and text/bytes; paths containing parent traversal are rejected.
- `installBrowserRuntime()`: install Bun, Deno and virtual fetch in this realm; returns its disposer.
- `UnsupportedRuntimeError`: an error with `ERR_BROWSER_RUNTIME_UNSUPPORTED`.
- `browserRuntimeBuildOptions(options?)` from `/build`: composable esbuild settings described below.

## Framework build options

`browserRuntimeBuildOptions` accepts explicit configuration rather than scanning an application's
filesystem or inheriting its environment:

- `adapters`: map a module name (bare or `node:`) to an absolute build-time adapter path. This is an
  explicit compatibility choice, including otherwise unsupported builtins. Native `.node` files
  are still refused. Framework imports can use browser implementations of their own dependencies.
- `optionalModules`: explicit optional imports that throw `ERR_BROWSER_RUNTIME_UNSUPPORTED` when
  evaluated; they never become empty mocks. Use only for capabilities the app does not invoke.
- `modules`: a finite map of module names to absolute build-time files. `createRequire` from
  `node:module` then loads only that manifest, caches results and rejects unknown names with
  `MODULE_NOT_FOUND`. Its filename argument does not add filesystem resolution. Dependencies are
  bundled, never loaded from the build machine at runtime.
- `assets`: explicit virtual filenames and public text/bytes, mounted before the entrypoint runs.
  No directory is scanned. Files supplied here are visible to every visitor.
- `sourceRoot`: replace `__filename`, `__dirname` and `import.meta` locations under this absolute
  root with virtual paths. Use minification and no source maps if build-machine paths must not
  appear in esbuild's own comments or source metadata.
- `transformSource`: an async source compiler hook returning `{ contents, loader? }` or undefined.
  A host can use TypeScript or SWC to emit legacy decorator metadata before esbuild bundles it.
- `virtualNetwork: true`: opt into virtual Node sockets, loopback-only DNS and in-memory diagnostic
  channels. TLS imports are allowed but every operation throws explicitly; no OS sockets open.
- `asyncContext: "zone"`: opt into the execution contract below.

App entrypoints, routes, environment allowlists, seed data and application-specific framework
choices stay with the host. These hooks do not imply arbitrary Nest or Next applications run unchanged.

## Async context execution contract

By default `node:async_hooks` fails at build time. Opting into `asyncContext: "zone"` supplies
`AsyncLocalStorage` and `AsyncResource` through Zone.js and forces esbuild to lower **every bundled
async function and async generator**, including dependencies, into instrumented Promise continuations.
It refuses options that retain native async functions or mark modules external. This is not a
Promise.then patch claimed to support native async/await.

The bundle must own a dedicated iframe/worker realm. Zone.js patches Promise and scheduling in that
realm; disposal does not uninstall Zone.js. Destroy the realm when the preview ends. Do not evaluate
untransformed code, dynamically import external native-async modules, or share the realm with an
unrelated application. A browser API that schedules callbacks outside Zone's patched integrations
needs its own verified adapter. Unsupported native async execution has no context-isolation guarantee.

Supported context operations are `getStore`, `run`, `exit`, `disable`, static `bind`/`snapshot`, and
`AsyncResource.runInAsyncScope`/`bind`/`emitDestroy`. `enterWith`, async IDs and lifecycle hooks throw
explicit unsupported errors. Chromium tests prove overlapping lowered async requests, nested scopes,
Promise callbacks, timers, errors, bound callbacks, disabled stores and destroyed resources.

## Compatibility

| Surface | Implementation and scope |
| --- | --- |
| `Buffer`, `process`, `global` | Injected into bundled modules; process is the browser implementation, not a host OS process. Environment starts empty, never inherits build-machine secrets. |
| `fs`, `fs/promises` | memfs: shared in-memory files, directories, streams, synchronous/callback/promise APIs. Data disappears on dispose/reload. |
| `path`, `path/posix`, `url`, `querystring`, `punycode` | Browser standard-library implementations; no host filesystem access. |
| `events`, `stream`, `string_decoder`, `util`, `assert` | node-stdlib-browser implementations; `assert/strict` default export supported. |
| `stream/web` | Native browser Web Streams. |
| `stream/promises` | Promise wrappers for pipeline and finished; no Node-specific options beyond the underlying implementation. |
| `crypto` | Browserify hashing, HMAC, PBKDF2, cipher/signature functions; browser Web Crypto, randomUUID and getRandomValues. Not every Node algorithm/API is implemented. |
| `zlib` | Browserify gzip/deflate; no native Brotli/Zstd guarantee. |
| `timers`, `timers/promises`, `console`, `os`, `constants`, `domain` | Browser implementations from node-stdlib-browser. OS information is synthetic. Timers use browser time. |
| `http` outgoing / `https` | Browser HTTP clients; browser CORS, cookie and forbidden-header restrictions still apply. |
| `http.createServer(handler).listen(port[, hostname][, callback])` | Basic Node Readable request / Writable response contract, streaming response bodies, local virtual listener. Supports request method, URL, headers, response status/headers/body and close. Not a full Node Server/socket implementation or a guarantee that Express/Next run unchanged. |
| `vm` | Browserify compatibility only; **not a security sandbox**, may require dynamic-code CSP permissions. |
| `Bun.serve`, `Deno.serve` | Fetch handlers registered as virtual localhost endpoints, no sockets; supports port/hostname, shutdown and finished. TLS, WebSocket upgrades, socket options and runtime-specific handler context are unsupported. |
| `Bun.file`, `Bun.write`, `Bun.env`, `Bun.sleep` | Virtual-file read facade (text/json/arrayBuffer/stream/slice/exists/size), byte/string/blob/response writes, explicit env and browser timers. The file facade is not a branded Blob for `new Response(Bun.file(...))`; use its stream or bytes. |
| Deno file APIs | readFile/readTextFile/writeFile/writeTextFile/mkdir/remove/rename (async and sync), stat/statSync, realPath/realPathSync, readDir, cwd, env on the same virtual filesystem. Node-style filesystem errors, not Deno's error classes. |

Both `node:` imports and bare Node module imports are mapped. The `bun` module exposes the same implemented Bun functions as the injected global. Unknown `node:` modules, native
`.node` addons, `bun:` builtins, child_process, cluster, dgram, dns, http2, net, tls, worker_threads,
async_hooks, module loading, terminal/readline/repl, inspector and v8 are rejected during builds.
Unknown Bun/Deno properties throw `ERR_BROWSER_RUNTIME_UNSUPPORTED` on access. Runtime version
probing and feature detection therefore need deliberate adaptation; the layer does not impersonate
a complete installed runtime. Raw TCP/TLS, OS processes, native addons, runtime compilers, arbitrary
npm/jsr/URL resolution at runtime and other language interpreters require separate explicit adapters
or suitable WASM runtimes. They are not supplied here.

## Worlds, routing and isolation

One bundled realm shares one world across Node fs/process and Bun/Deno. Separate iframes/workers
give systems separate globals; `createBrowserRuntime()` creates isolated worlds for injected-port
code and tests without changing globals.

The virtual network recognizes localhost, 127.0.0.1, 0.0.0.0 and [::1]. A missing listener rejects
locally: it never falls through to a real service on the user's machine. Ports cannot collide;
port zero allocates an available virtual port. Requests preserve method/body/headers and support
abort. Node response headers and bytes are available before end, with cancellation and stream errors. No cross-tab network, virtual DNS for arbitrary hostnames, service-worker interception or
websocket transport is implied.

Instances created through `createBrowserRuntime()` have external network access disabled unless
a fetch port is supplied. The installed browser singleton permits normal browser fetch for external
origins. Its globals are for trusted preview code, not a security boundary. Environment values
and files delivered to the browser are visible to the visitor; never put production secrets there.

## Framework fixtures and limits

Chromium fixtures execute an actual Fastify HTTP route and an actual Nest dependency-injected,
decorated controller over Fastify. The Nest fixture explicitly excludes optional validation,
microservice, WebSocket, static/view and Express dependencies it never invokes; using those requires
additional adapters. HTTP/2 has an explicit fail-on-use adapter at `/http2-unsupported`.

A Next fixture exercises real `NextRequest`/`NextResponse` and React streamed server rendering with
overlapping request contexts. It is not a complete Next application build, route loader, image
optimizer or filesystem router qualification. The host still owns the appropriate framework entrypoint.

The `perf_hooks` adapter exposes browser `performance`/`PerformanceObserver`; Node histogram/event-loop
sampling throws. `process.hrtime` and `uptime` use monotonic browser time. Diagnostic channels support
subscription, publication, store binding and synchronous tracing; `tracePromise` and `traceCallback`
throw explicit unsupported errors. Transport-specific exports are `/http`, `/net`, `/network/dns`,
`/network/tls` and `/network/diagnostics-channel` for hosts using injected worlds or explicit adapters.

## Validation

`bun test` checks world isolation, shared Bun/Deno files, missing paths, listener collisions,
shutdown, abort, explicit unsupported APIs and rejected native imports. A bundled Chromium
contract test runs real Node imports (hashing/compression/events/files) and Node/Bun/Deno servers
together, rather than accidentally testing the machine's native runtime.
