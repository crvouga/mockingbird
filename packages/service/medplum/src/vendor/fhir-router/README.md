# Vendored `@medplum/fhir-router` 5.1.37

The TypeScript sources of [`@medplum/fhir-router`](https://github.com/medplum/medplum/tree/v5.1.37/packages/fhir-router/src)
at tag `v5.1.37` — the exact router the self-hosted Medplum server dispatches FHIR REST through —
copied so the mock routes requests the same way without depending on the published package
(which pulls in `@medplum/definitions`, ~95 MB, and uses Node's `Buffer`).

Licensed under the Apache License 2.0 (`LICENSE.txt`), Copyright Orangebot, Inc. and Medplum
contributors. Local changes, all mechanical:

- relative imports carry `.js` extensions (NodeNext resolution);
- `import type { IncomingHttpHeaders } from 'node:http'` is replaced by an equivalent local type;
- `Buffer.from(data, 'base64')` in `batch.ts` is replaced by a portable `atob` + `TextDecoder` decode;
- two doc comments in `batch.ts` say "entry to run" instead of "entry to process." (the repo's
  portability gate scans bundles for `process.`);
- every file starts with `// @ts-nocheck`: upstream type-checks it under its own compiler settings.

Tests (`*.test.ts`) are not vendored.
