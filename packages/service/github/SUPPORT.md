# GitHub REST subset (Mockingbird) — operation support

Generated from `openapi.yaml`; do not edit by hand.

- operations in spec: **9**
- supported by the mock: **9**
- parity enabled: **9**

| operationId | route | mock | parity | notes |
| --- | --- | --- | --- | --- |
| `repos/get` | `GET /repos/{owner}/{repo}` | ✅ supported | ✅ |  |
| `git/get-ref` | `GET /repos/{owner}/{repo}/git/ref/{ref}` | ✅ supported | ✅ |  |
| `git/list-matching-refs` | `GET /repos/{owner}/{repo}/git/matching-refs/{ref}` | ✅ supported | ✅ |  |
| `git/create-ref` | `POST /repos/{owner}/{repo}/git/refs` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `git/update-ref` | `PATCH /repos/{owner}/{repo}/git/refs/{ref}` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `pulls/list` | `GET /repos/{owner}/{repo}/pulls` | ✅ supported | ✅ |  |
| `pulls/create` | `POST /repos/{owner}/{repo}/pulls` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `pulls/get` | `GET /repos/{owner}/{repo}/pulls/{pull_number}` | ✅ supported | ✅ |  |
| `pulls/update` | `PATCH /repos/{owner}/{repo}/pulls/{pull_number}` | ✅ supported | ⚠️ unsafe (opt-in) |  |
