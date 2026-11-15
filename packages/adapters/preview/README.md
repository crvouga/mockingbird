# @crvouga/mockingbird-preview

> Local emulators. Real API contracts. Part of [Mockingbird](https://github.com/crvouga/mockingbird).

Reusable infrastructure for static application previews: a streaming Fetch bridge over MessagePort,
shared worker lifecycle, verified compressed assets, a Node test adapter, and Cloudflare named
Worker Preview deployment. App entrypoints, schemas, synthetic fixtures, credentials acquisition,
cloud identities and organization CI policy remain in the consuming application.

## Install

```sh
npm install @crvouga/mockingbird-preview
```

## Usage

A module worker creates its application once, and attaches each visiting page to that same system:

```ts
import { createPreviewHost, installPreviewWorkerHost } from "@crvouga/mockingbird-preview"

const host = createPreviewHost({
  artifact: "sha256:the-build-identity",
  boot: async ({ generation, signal }) => ({
    fetch: (request) => Response.json({ generation, path: new URL(request.url).pathname }),
    dispose: async () => {},
  }),
  allow: (url) => url.hostname === "app.preview",
})

installPreviewWorkerHost(host, self)
```

The page uses `connectSharedPreviewWorker("/worker.js", { application: "demo", artifact:
"sha256:the-build-identity", generation: 0 })` and its returned `fetch`. The browser's normal
same-origin restrictions apply to the worker URL. Each connected page has isolated in-flight
requests. Disconnecting a page does not dispose the shared system. Call `host.reset()` to abort
connections, dispose state and boot the next generation; reconnect clients afterwards. A failed
boot is visible through `status()` and returns HTTP 503. Calling `dispose()` terminates the host.
The application must honor the boot/request AbortSignals to terminate work it started.

## API

- `createPreviewClient(port, options)` exposes `fetch`, `dispose()` and the number of pending
  requests. `timeoutMs` covers response headers and the complete response stream (30 seconds by
  default); configure it for intentionally long-lived streams. Worker death without a port error
  is detected by this deadline. `allow(url)` optionally restricts destinations at the client.
- `servePreviewPort(port, fetch, options)` handles requests through the application's Fetch
  handler. Responses use transferable ArrayBuffers and one chunk per consumer pull; cancellation
  aborts the handler's signal and reader. Pre-header failures reject fetch and post-header failures
  error its body. Error messages are opaque to avoid leaking server details. `maxRequests`
  bounds concurrent requests per port, default 128. `onClose` supports connection accounting.
- `createPreviewHost({ artifact, boot, allow })` serializes boot/reset/dispose and exposes
  `connect`, `fetch`, `status`, `ready`, `reset` and `dispose`. It owns no emulator-specific state:
  use a fleet's lifecycle inside the boot/dispose callbacks.
- `sharedPreviewWorkerName({ application, artifact, generation })` creates an unambiguous worker
  identity; changing artifact or generation creates a distinct SharedWorker.
- `connectSharedPreviewWorker(url, options)` opens a module SharedWorker and connects its port.
  `connectDedicatedPreviewWorker(url, options)` uses a dedicated module Worker and transferred
  MessageChannel. Both expose `fetch`, `pending`, `worker` and `dispose`; worker errors reject
  pending requests. Dedicated disposal also terminates its worker.
- `installPreviewWorkerHost(host, scope)` accepts SharedWorker connection events and dedicated
  worker MessagePort handshakes. Returns an async disposer.
- `createPreviewArtifact(bytes, { commit, url, encoding })` records format version, source commit,
  exact packed byte count and SHA-256. `parsePreviewArtifact(value)` validates this manifest.
  `digestPreviewBytes(bytes)` returns a lowercase SHA-256 digest.
- `loadPreviewArtifact(manifest, options)` fetches with `no-store`, no credentials and redirect
  refusal; checks expected commit, size and hash before optional gzip decompression. Packed and
  decompressed sizes are bounded by `maximumBytes` (128 MiB default). The result is bytes; the
  caller deliberately chooses how to execute or persist trusted application code. It never evals
  arbitrary fetched source.
- `selectPreviewAction(currentFacts, builtCommit)` chooses deploy/remove/skip from current PR
  state. Closed PRs select removal; forks and stale build heads cannot deploy.
- `planPreviewSweep({ previews, openNames, owns, now, retentionMs, capacity })` is a pure plan
  listing managed names removed for orphaning, expiry or capacity. It never removes unmanaged
  names or performs cloud operations. Capacity eviction retains the newest managed previews.
- `createCloudflarePreviews({ accountId, workerName, token, fetch })` returns `deploy`, `list` and
  `remove`. `deploy` takes explicit static files, source commit, a name and a `currentPullRequest`
  callback. It checks current facts before upload and immediately before deployment, sends only
  missing assets, preserves optional `_headers` text and uses content identity to avoid repeating
  an already identical deployment. `list` follows pages and throws on API failures; `remove`
  treats HTTP 404 as success. No production Worker deployment is changed.
- `previewNodeHandler(fetch)` and `listenPreview(fetch, { port, hostname })`, from the `/node`
  export, expose the same Fetch handler or browser bridge to a Node HTTP test runner. The default
  listener is loopback on an ephemeral port. Responses are always `Cache-Control: no-store` to
  avoid browser worker-asset cache failures. Stream errors destroy the response instead of
  creating a successful EOF. Call the returned `close()` to release the listener.

## Cookies, redirects and trust

The bridge defaults to removing Cookie and Set-Cookie headers. It does not borrow browser cookies
or impersonate the page origin. For a fully virtual application, both bridge ends may opt into
`cookies: true`; that carries explicitly supplied cookie headers, but supplies no cookie jar and
never writes `document.cookie`. The host must own a jar per intended user/session if needed.
Responses preserve redirect statuses and Location; redirects are always manual, including when a
Request uses its usual `follow` default. Follow redirects explicitly through the same allowlisted
Fetch boundary. Do not forward authorization/cookies to a new origin. These deliberate rules avoid
silently following an allowed virtual request into a real production host.

Request bodies are buffered before transfer; response bodies stream with backpressure. This is
not a streaming request-upload implementation. Ports are trusted capabilities, not an untrusted
RPC/authentication boundary. Browser-delivered code, environment values and files remain visible
and editable by the visitor. Never put production or shared secret values in these artifacts.

Cloudflare helpers require an existing parent Worker and explicit account credentials on the
trusted CI/server side. They create named Preview resources with base-config inheritance disabled,
no environment bindings, and assets-only deployments. Existing organization ownership/naming
rules remain the caller's responsibility. Per-PR deployment jobs must be serialized externally:
the final head re-read narrows, but cannot eliminate, races without a provider compare-and-swap.
A retry after an ambiguous create response should re-read the named preview before retrying.
No live cloud credentials were used for the package's acceptance tests.

Cloudflare protocol references:
[official Preview API implementation](https://github.com/cloudflare/workers-sdk/blob/main/packages/deploy-helpers/src/preview/api.ts),
[asset upload documentation](https://developers.cloudflare.com/workers/static-assets/direct-upload/),
[Worker Previews](https://developers.cloudflare.com/workers/previews/).

## Validation

Tests exercise concurrent requests, first-chunk delivery, cancellation, deadlines, failures on
both sides of response headers, target restrictions, two virtual apps sharing a real Chromium
SharedWorker, reset/disconnect, compressed integrity/size limits, the Node HTTP adapter, and injected
Cloudflare upload/pagination/stale-head/deletion failures. Cloudflare behavior is based on official
API source and documentation, not a live-account parity claim.

## Runtime compatibility

`@crvouga/mockingbird-runtime/preview/*` delegates to this package, preserving its legacy signatures.
`loadPreviewArtifact` also accepts `LegacyPreviewArtifact` (`version: 1`, `sha256`, `url`, optional
`compression: "gzip"`), whose hash covers decoded bytes. Legacy downloads still enforce the same
bounded loading, no-store and redirect policy; they cannot satisfy `expectedCommit` because they
carry no commit. New manifests cover packed bytes, size and source commit.

The bridge's `exposeErrors: true` option on both ends exists for trusted legacy compatibility.
It forwards original error messages and must not be enabled on a boundary that needs opaque
errors. Both ends must also opt into `cookies: true` to transport explicit virtual cookie headers.
These options do not create a browser cookie jar or expose server-held credentials.
