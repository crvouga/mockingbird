# Browser system runtime

Run server-oriented JavaScript in static, browser-local system previews. This adapter supplies a
shared virtual filesystem and network plus a bundler configuration for Node standard-library
polyfills. It is an explicit compatibility layer, not a complete Node, Bun or Deno implementation.
Native executables and arbitrary server packages cannot all run through JavaScript polyfills.

## Host integration

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
await import("./system.js")
// When the entire preview ends: dispose()
```

The lab's standalone preview uses this build configuration. Existing browser-compatible code
keeps its Fetch API contracts. The docs embed does not install globals into its parent page.

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
| `http.createServer(handler).listen(port[, hostname][, callback])` | Basic Node Readable request / Writable response contract, buffered response bodies, local virtual listener. Supports request method, URL, headers, response status/headers/body and close. Not a full Node Server/socket implementation or a guarantee that Express/Next run unchanged. |
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
abort. Responses use browser streams through Fetch; the basic Node response adapter buffers until
end. No cross-tab network, virtual DNS for arbitrary hostnames, service-worker interception or
websocket transport is implied.

Instances created through `createBrowserRuntime()` have external network access disabled unless
a fetch port is supplied. The installed browser singleton permits normal browser fetch for external
origins. Its globals are for trusted preview code, not a security boundary. Environment values
and files delivered to the browser are visible to the visitor; never put production secrets there.

## Validation

`bun test` checks world isolation, shared Bun/Deno files, missing paths, listener collisions,
shutdown, abort, explicit unsupported APIs and rejected native imports. A bundled Chromium
contract test runs real Node imports (hashing/compression/events/files) and Node/Bun/Deno servers
together, rather than accidentally testing the machine's native runtime.
