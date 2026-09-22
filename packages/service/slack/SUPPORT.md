# Slack incoming webhooks and Web API (Mockingbird subset) — operation support

Generated from `openapi.yaml`; do not edit by hand.

- operations in spec: **20**
- supported by the mock: **20**
- parity enabled: **20**

| operationId | route | mock | parity | notes |
| --- | --- | --- | --- | --- |
| `PostIncomingWebhook` | `POST /services/{team}/{bot}/{secret}` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `ChatPostMessage` | `POST /api/chat.postMessage` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `ChatUpdate` | `POST /api/chat.update` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `ChatPostEphemeral` | `POST /api/chat.postEphemeral` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `ChatGetPermalinkGet` | `GET /api/chat.getPermalink` | ✅ supported | ✅ |  |
| `ChatGetPermalink` | `POST /api/chat.getPermalink` | ✅ supported | ✅ |  |
| `ReactionsAdd` | `POST /api/reactions.add` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `ReactionsRemove` | `POST /api/reactions.remove` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `ReactionsGetGet` | `GET /api/reactions.get` | ✅ supported | ✅ |  |
| `ReactionsGet` | `POST /api/reactions.get` | ✅ supported | ✅ |  |
| `AuthTestGet` | `GET /api/auth.test` | ✅ supported | ✅ |  |
| `AuthTest` | `POST /api/auth.test` | ✅ supported | ✅ |  |
| `ConversationsJoin` | `POST /api/conversations.join` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `UsersInfoGet` | `GET /api/users.info` | ✅ supported | ✅ |  |
| `UsersInfo` | `POST /api/users.info` | ✅ supported | ✅ |  |
| `UsersLookupByEmailGet` | `GET /api/users.lookupByEmail` | ✅ supported | ✅ |  |
| `UsersLookupByEmail` | `POST /api/users.lookupByEmail` | ✅ supported | ✅ |  |
| `FilesInfoGet` | `GET /api/files.info` | ✅ supported | ✅ |  |
| `FilesInfo` | `POST /api/files.info` | ✅ supported | ✅ |  |
| `ViewsOpen` | `POST /api/views.open` | ✅ supported | ⚠️ unsafe (opt-in) |  |
