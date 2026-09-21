# Daily.co REST API (Mockingbird subset) — operation support

Generated from `openapi.yaml`; do not edit by hand.

- operations in spec: **8**
- supported by the mock: **8**
- parity enabled: **8**

| operationId | route | mock | parity | notes |
| --- | --- | --- | --- | --- |
| `CreateRoom` | `POST /v1/rooms` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `GetRoom` | `GET /v1/rooms/{name}` | ✅ supported | ✅ |  |
| `UpdateRoom` | `POST /v1/rooms/{name}` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `DeleteRoom` | `DELETE /v1/rooms/{name}` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `GetRoomPresence` | `GET /v1/rooms/{name}/presence` | ✅ supported | ✅ |  |
| `EjectParticipants` | `POST /v1/rooms/{name}/eject` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `CreateMeetingToken` | `POST /v1/meeting-tokens` | ✅ supported | ✅ |  |
| `ValidateMeetingToken` | `GET /v1/meeting-tokens/{token}` | ✅ supported | ✅ |  |
