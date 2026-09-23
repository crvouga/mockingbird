# Mailosaur API (Mockingbird subset) — operation support

Generated from `openapi.yaml`; do not edit by hand.

- operations in spec: **8**
- supported by the mock: **8**
- parity enabled: **6**

| operationId | route | mock | parity | notes |
| --- | --- | --- | --- | --- |
| `SearchMessages` | `POST /api/messages/search` | ✅ supported | ✅ |  |
| `AwaitMessageByQuery` | `GET /api/messages/await` | ✅ supported | ❌ disabled | Holds the request open for up to `timeout` ms; exercised by the acceptance tests. |
| `AwaitMessage` | `POST /api/messages/await` | ✅ supported | ❌ disabled | Holds the request open for up to `timeout` ms; exercised by the acceptance tests. |
| `ListMessages` | `GET /api/messages` | ✅ supported | ✅ |  |
| `CreateMessage` | `POST /api/messages` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `DeleteAllMessages` | `DELETE /api/messages` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `GetMessage` | `GET /api/messages/{id}` | ✅ supported | ✅ |  |
| `DeleteMessage` | `DELETE /api/messages/{id}` | ✅ supported | ⚠️ unsafe (opt-in) |  |
