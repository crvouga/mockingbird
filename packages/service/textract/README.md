# @crvouga/mockingbird-service-textract

Stateful Amazon Textract mock for the official SDK v3 client. It models synchronous and asynchronous document analysis, connected block graphs, stable pagination, idempotency, and completion notifications.

## Install

```bash
npm install -D @crvouga/mockingbird-service-textract
```

ESM only. Node 22+ or Bun 1.2+.

## Usage

```ts
import { createServer } from "@crvouga/mockingbird-service-textract/server"

const mock = await createServer({
  corpora: [{ bucket: "fixtures", name: "invoice.pdf", pages: 1, blocks: [] }],
})
const health = await fetch(`${mock.url}/health`)
```

Point `TextractClient.endpoint` at `mock.url` with fixture SigV4 credentials. Supported operations are AnalyzeDocument, StartDocumentAnalysis, and GetDocumentAnalysis. Block records retain PAGE, LINE, WORD, KEY_VALUE_SET, TABLE, CELL, and SELECTION_ELEMENT graph fields including Geometry, Confidence, EntityTypes, Text, and Relationships.

## Controls

- `GET/POST /__admin/corpora` lists or seeds a block graph by S3 bucket, key, and optional version.
- `GET /__admin/jobs` and `GET /__admin/jobs/:id` inspect exact submitted jobs.
- `POST /__admin/jobs/:id/transition` moves a job to `SUCCEEDED`, `PARTIAL_SUCCESS`, or `FAILED`, with an optional `statusMessage`.
- Corpus fixtures choose `pageSize` to force deterministic page boundaries and can contain low-confidence blocks, malformed relationships, and warnings.
- Fault presets are `throttled`, `throughput_exceeded`, and `unavailable`.

Terminal jobs with a NotificationChannel publish an SNS-compatible Textract status body through the shared webhook hub. The shared runtime also provides reset, clock, journal, metrics, faults, and namespace isolation.

## API

- `TextractAPI`, `TextractAPIOptions`, `TextractNotification`: portable handler and notification contract.
- `TextractBlock`, `TextractCorpus`, `TextractJob`, `TextractJobStatus`: fixtures and durable state.
- `createRuntime`, `TextractRuntime`, `TextractRuntimeOptions`: full Mockingbird runtime and webhook hub.
- `TEXTRACT_NAMESPACE`, `TEXTRACT_PRESETS`, `accessKeyCredential`: constants and fault controls.
- `document`, `operationIds`, `supportedOperationIds`: generated OpenAPI metadata.
- `createServer`, `TextractServerOptions`, `DEFAULT_PORT`, `serveTarget` from `./server`: Node HTTP adapter and CLI integration.

## Deliberately not modelled

OCR, S3 access, IAM evaluation, adapters, output delivery, production limits, billing, dashboards, and Textract operations outside the documented subset are not modelled.

Official oracle: [Amazon Textract API Reference](https://docs.aws.amazon.com/textract/latest/dg/API_Reference.html).
