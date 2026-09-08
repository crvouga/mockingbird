# Junction API (Mockingbird subset) — operation support

Generated from `openapi.yaml`; do not edit by hand.

- operations in spec: **16**
- supported by the mock: **16**
- parity enabled: **14**

| operationId | route | mock | parity | notes |
| --- | --- | --- | --- | --- |
| `get_teams_users_v2_user_get` | `GET /v2/user` | ✅ supported | ✅ |  |
| `create_user_v2_user_post` | `POST /v2/user` | ✅ supported | ✅ |  |
| `get_user_v2_user__user_id__get` | `GET /v2/user/{user_id}` | ✅ supported | ✅ |  |
| `delete_user_v2_user__user_id__delete` | `DELETE /v2/user/{user_id}` | ✅ supported | ✅ |  |
| `patch_user_v2_user__user_id__patch` | `PATCH /v2/user/{user_id}` | ✅ supported | ✅ |  |
| `get_user_by_client_user_id_v2_user_resolve__client_user_id__get` | `GET /v2/user/resolve/{client_user_id}` | ✅ supported | ✅ |  |
| `get_paginated_lab_tests_for_team_v3_lab_test_get` | `GET /v3/lab_test` | ✅ supported | ✅ |  |
| `get_lab_test_for_team_v3_lab_tests__lab_test_id__get` | `GET /v3/lab_tests/{lab_test_id}` | ✅ supported | ✅ |  |
| `create_order_v3_order_post` | `POST /v3/order` | ✅ supported | ✅ |  |
| `patch_user_info_v2_user__user_id__info_patch` | `PATCH /v2/user/{user_id}/info` | ✅ supported | ✅ |  |
| `get_order_v3_order__order_id__get` | `GET /v3/order/{order_id}` | ✅ supported | ✅ |  |
| `cancel_order_v3_order__order_id__cancel_post` | `POST /v3/order/{order_id}/cancel` | ✅ supported | ✅ |  |
| `simulate_order_v3_order__order_id__test_post` | `POST /v3/order/{order_id}/test` | ✅ supported | ✅ |  |
| `get_orders_v3_orders_get` | `GET /v3/orders` | ✅ supported | ✅ |  |
| `get_order_transaction_v3_order_transaction__transaction_id__get` | `GET /v3/order_transaction/{transaction_id}` | ✅ supported | ❌ disabled | order transactions are not available to the sandbox team (feature not available) |
| `get_order_transaction_result_v3_order_transaction__transaction_id__result_get` | `GET /v3/order_transaction/{transaction_id}/result` | ✅ supported | ❌ disabled | lab results are not available to the sandbox team (feature not available) |
