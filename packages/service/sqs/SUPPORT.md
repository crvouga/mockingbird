# Amazon SQS (Mockingbird subset) — operation support

Generated from `openapi.yaml`; do not edit by hand.

- operations in spec: **2**
- supported by the emulator: **2**
- parity enabled: **1**

| operationId | route | emulator | parity | notes |
| --- | --- | --- | --- | --- |
| `SqsRpc` | `POST /` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `SqsQueryQueue` | `POST /{AccountId}/{QueueName}` | ✅ supported | ❌ disabled | Query-protocol requests are covered by package tests; live parity drives AWS JSON through SqsRpc. |
