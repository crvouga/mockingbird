# Healthie GraphQL API (Mockingbird subset) — operation support

Generated from `openapi.yaml`; do not edit by hand.

- operations in spec: **2**
- supported by the emulator: **2**
- parity enabled: **2**

| operationId | route | emulator | parity | notes |
| --- | --- | --- | --- | --- |
| `Graphql` | `POST /graphql` | ✅ supported | ⚠️ unsafe (opt-in) | A hand-written subset of Healthie's GraphQL schema; README lists every root field that is modelled and those that are not. userGroups, organizationMembers and User.state_licenses are a best guess from vendor docs, not oracle-verified. |
| `DownloadFile` | `GET /files/{fileToken}` | ✅ supported | ✅ |  |
