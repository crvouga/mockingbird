# Amazon Bedrock Runtime + AgentCore harness (Mockingbird subset) — operation support

Generated from `openapi.yaml`; do not edit by hand.

- operations in spec: **6**
- supported by the mock: **5**
- parity enabled: **4**

| operationId | route | mock | parity | notes |
| --- | --- | --- | --- | --- |
| `Converse` | `POST /model/{modelId}/converse` | ✅ supported | ✅ |  |
| `ConverseStream` | `POST /model/{modelId}/converse-stream` | ✅ supported | ✅ |  |
| `InvokeModel` | `POST /model/{modelId}/invoke` | ✅ supported | ✅ |  |
| `InvokeModelWithResponseStream` | `POST /model/{modelId}/invoke-with-response-stream` | ❌ unsupported | — | No consumer calls it; chat streaming goes through ConverseStream. |
| `InvokeModelWithBidirectionalStream` | `POST /model/{modelId}/invoke-with-bidirectional-stream` | ✅ supported | ❌ disabled | A duplex HTTP/2 session; random request bodies cannot drive it. |
| `InvokeHarness` | `POST /harnesses/invoke` | ✅ supported | ✅ |  |
