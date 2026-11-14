# @crvouga/mockingbird-runtime

> Local emulators. Real API contracts. Part of [Mockingbird](https://github.com/crvouga/mockingbird).

The runtime every Mockingbird emulator service is built on: the router, the `/__admin` API and
page, snapshots, faults, the clock, and the HTTP and OpenAPI helpers. Each
`@crvouga/mockingbird-service-*` package depends on it at the same version, so an application
that installs or bundles several emulators carries one copy of it, not one per service. The
admin page's browser client (`dist/admin-ui.js`) is loaded only on the first `/__admin/ui`
request.

You do not import it yourself: install an emulator and it comes along.

## Install

```sh
npm install -D @crvouga/mockingbird-runtime
```

It is installed with every emulator, so this is only needed to pin it.

## Usage

```ts
import { createRuntime } from "@crvouga/mockingbird-service-sqs"

const sqs = createRuntime()
const response = await sqs.fetch(new Request("http://sqs.local/__admin/health"))
```

## API

- `RUNTIME_SUBPATHS`: the subpaths this package exports (`core`, `service`, `sqlite`, …), each
  re-exporting the Mockingbird helper of that name.

The subpaths are internal to the emulator services and may change in any release; depend on a
service's own exports instead.

To leave the admin page's client out of a single-file application bundle, mark it external
(`esbuild --external:./admin-ui.js`); `/__admin/ui` then answers 503 and everything else works.
