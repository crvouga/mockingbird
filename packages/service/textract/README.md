# @crvouga/mockingbird-service-textract

> Local emulators. Real API contracts. Part of [Mockingbird](https://github.com/crvouga/mockingbird).

Stateful Amazon Textract emulator for the official SDK v3 client. It models synchronous and asynchronous document analysis, connected block graphs, stable pagination, idempotency, and completion notifications.

## Install

```bash
npm install -D @crvouga/mockingbird-service-textract
```

ESM only. Node 22+ or Bun 1.2+.

## Usage

```ts
import { AnalyzeDocumentCommand, TextractClient } from "@aws-sdk/client-textract"
import { createServer } from "@crvouga/mockingbird-service-textract/server"

// Test setup: start the emulator with a seeded document and point the SDK's endpoint at it.
const server = await createServer({
  corpora: [
    {
      bucket: "fixtures",
      name: "invoice.pdf",
      pages: 1,
      blocks: [{ id: "line-1", blockType: "LINE", page: 1, text: "Total due 42.00", confidence: 99 }],
    },
  ],
})
const textract = new TextractClient({
  endpoint: server.url,
  region: "us-east-1",
  credentials: { accessKeyId: "fixture", secretAccessKey: "fixture" },
})

// Application code: the Textract SDK calls it already makes.
const analysis = await textract.send(
  new AnalyzeDocumentCommand({
    Document: { S3Object: { Bucket: "fixtures", Name: "invoice.pdf" } },
    FeatureTypes: ["FORMS"],
  }),
)
console.log(analysis.Blocks?.map((block) => block.Text)) // [ "Total due 42.00" ]

await server.close()
```

Point `TextractClient.endpoint` at `server.url` with fixture SigV4 credentials. Supported operations are AnalyzeDocument, StartDocumentAnalysis, and GetDocumentAnalysis. Block records retain PAGE, LINE, WORD, KEY_VALUE_SET, TABLE, CELL, and SELECTION_ELEMENT graph fields including Geometry, Confidence, EntityTypes, Text, and Relationships.

## Controls

- `GET/POST /__admin/corpora` lists or seeds a block graph by S3 bucket, key, and optional version.
- `GET /__admin/jobs` and `GET /__admin/jobs/:id` inspect exact submitted jobs.
- `POST /__admin/jobs/:id/transition` moves a job to `SUCCEEDED`, `PARTIAL_SUCCESS`, or `FAILED`, with an optional `statusMessage`.
- Corpus fixtures choose `pageSize` to force deterministic page boundaries and can contain low-confidence blocks, malformed relationships, and warnings.
- Fault presets are `throttled`, `throughput_exceeded`, and `unavailable`.

Terminal jobs with a NotificationChannel publish an SNS-compatible Textract status body through the shared webhook hub. The shared runtime also provides reset, clock, journal, metrics, faults, and namespace isolation.

## API

- `TextractAPI`, `TextractAPIOptions`, `TextractNotification`: handler and notification contract.
- `TextractBlock`, `TextractCorpus`, `TextractJob`, `TextractJobStatus`: fixtures and durable state.
- `createRuntime`, `TextractRuntime`, `TextractRuntimeOptions`: full Mockingbird runtime and webhook hub.
- `TEXTRACT_NAMESPACE`, `TEXTRACT_PRESETS`, `accessKeyCredential`: constants and fault controls.
- `document`, `operationIds`, `supportedOperationIds`: generated OpenAPI metadata.
- `createServer`, `TextractServerOptions`, `DEFAULT_PORT`, `serveTarget` from `./server`: Node HTTP adapter and CLI integration.

## Deliberately not modelled

OCR, S3 access, IAM evaluation, adapters, output delivery, production limits, billing, dashboards, and Textract operations outside the documented subset are not modelled.

Official oracle: [Amazon Textract API Reference](https://docs.aws.amazon.com/textract/latest/dg/API_Reference.html).
