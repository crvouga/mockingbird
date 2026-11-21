# Browser-local Node transports

`browserRuntimeBuildOptions({ virtualNetwork: true })` opts into virtual `node:net` sockets.
The default build still refuses that import. The virtual network never opens OS sockets,
performs external DNS, or connects to the visitor's real localhost services.

Each `createBrowserRuntime()` owns `net`. Use `world.net.createServer(socket =>
wireServer.accept(socket)).listen(port)` to bind the existing Postgres or Redis `/transport`
server. The clients can use the bundled Node `net` API against the singleton, or accept the
world's `Socket` through their explicit stream injection option. Separate worlds can bind the
same port. Duplicate listeners fail; port zero chooses a free virtual port; absent listeners
reject with `ECONNREFUSED`. Bytes and backpressure flow through Node-compatible Duplex streams.

`createHttpAdapter(world)` from the HTTP module binds Node handlers to that world's Fetch
listeners. The default Node HTTP exports use the singleton world. Responses expose headers
before completion, stream bytes under consumer backpressure, and propagate errors after headers
to the response body. Request abort and response-body cancellation close the paired streams.
HEAD, 204, 205 and 304 responses have no body. Repeated Set-Cookie header values are preserved
by the Node response API; browser Fetch still imposes its normal cookie visibility rules.

Closing a virtual server or disposing the world terminates active connections immediately. This
is deliberate preview teardown behavior, not Node's graceful server-close guarantee. TCP sockets and HTTP listeners share port collision checks within a world. No TLS, Unix socket, TCP congestion-control,
WebSocket upgrade, HTTP/2, cluster, sentinel or general DNS fidelity is claimed.

For clients that eagerly import optional Node capabilities, explicitly supplied adapters may
be necessary. The included `src/network/tls.ts` throws for every TLS operation; `dns.ts` supports
only loopback lookup and refuses SRV; `diagnostics-channel.ts` supplies the documented in-memory
diagnostic channels and rejects unsupported tracing operations. They are never activated by default. A client configured to use TLS must
fail, not silently downgrade to plaintext. Framework async context is a separate build option.

The transport tests cover first-byte delivery before end, backpressure, abort/cancellation,
pre-header and streamed errors, cookies/no-body responses, TCP byte exchange, isolation,
collisions and disposal. The Chromium contract additionally bundles real pg, ioredis and Express
against the emulator transports. This proves the named fixture operations, not complete
compatibility with every API of those packages.

## Outgoing Node requests

`createFetchHttpClient(fetch, protocol)` from `./http-client` supplies Node-style `request` and
`get` over a host-owned Fetch port. Request bodies are buffered until `end`; response bytes stream
through a Readable with backpressure, cancellation and error propagation. The explicit module
adapter's default exports use the current global Fetch function and HTTPS as the default protocol.
The host owns routing and refusal of unmatched destinations; this adapter is not an outbound
allowlist. It opens no native socket and performs no connection pooling. HTTP/2 and TLS socket
operations remain unsupported. The FCM Chromium fixture verifies the real Firebase Admin SDK's
single-send and legacy multicast paths against strict local emulator authentication.
