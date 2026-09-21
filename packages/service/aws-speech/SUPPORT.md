# Amazon Polly + Amazon Transcribe (Mockingbird subset) — operation support

Generated from `openapi.yaml`; do not edit by hand.

- operations in spec: **4**
- supported by the mock: **4**
- parity enabled: **2**

| operationId | route | mock | parity | notes |
| --- | --- | --- | --- | --- |
| `SynthesizeSpeech` | `POST /v1/speech` | ✅ supported | ✅ |  |
| `StartSpeechSynthesisStream` | `POST /v1/synthesisStream` | ✅ supported | ❌ disabled | A duplex HTTP/2 session driven by the SDK's event stream; random bodies cannot drive it. |
| `StartStreamTranscription` | `POST /stream-transcription` | ✅ supported | ❌ disabled | A duplex HTTP/2 session driven by the SDK's event stream; random bodies cannot drive it. |
| `TranscribeJsonRpc` | `POST /` | ✅ supported | ⚠️ unsafe (opt-in) |  |
