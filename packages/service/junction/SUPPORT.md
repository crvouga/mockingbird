# Junction API (Mockingbird subset) — operation support

Generated from `openapi.yaml`; do not edit by hand.

- operations in spec: **38**
- supported by the mock: **38**
- parity enabled: **23**

| operationId | route | mock | parity | notes |
| --- | --- | --- | --- | --- |
| `get_teams_users_v2_user_get` | `GET /v2/user` | ✅ supported | ✅ |  |
| `create_user_v2_user_post` | `POST /v2/user` | ✅ supported | ✅ |  |
| `get_user_v2_user__user_id__get` | `GET /v2/user/{user_id}` | ✅ supported | ✅ |  |
| `delete_user_v2_user__user_id__delete` | `DELETE /v2/user/{user_id}` | ✅ supported | ✅ |  |
| `patch_user_v2_user__user_id__patch` | `PATCH /v2/user/{user_id}` | ✅ supported | ✅ |  |
| `get_user_by_client_user_id_v2_user_resolve__client_user_id__get` | `GET /v2/user/resolve/{client_user_id}` | ✅ supported | ✅ |  |
| `patch_user_info_v2_user__user_id__info_patch` | `PATCH /v2/user/{user_id}/info` | ✅ supported | ✅ |  |
| `get_latest_user_info_user_v2_user__user_id__info_latest_get` | `GET /v2/user/{user_id}/info/latest` | ✅ supported | ✅ |  |
| `get_paginated_lab_tests_for_team_v3_lab_test_get` | `GET /v3/lab_test` | ✅ supported | ✅ |  |
| `get_lab_test_for_team_v3_lab_tests__lab_test_id__get` | `GET /v3/lab_tests/{lab_test_id}` | ✅ supported | ✅ |  |
| `get_labs_v3_lab_tests_labs_get` | `GET /v3/lab_tests/labs` | ✅ supported | ✅ |  |
| `get_markers_for_lab_test_v3_lab_tests__lab_test_id__markers_get` | `GET /v3/lab_tests/{lab_test_id}/markers` | ✅ supported | ✅ |  |
| `list_order_set_markers_v3_lab_tests_list_order_set_markers_post` | `POST /v3/lab_tests/list_order_set_markers` | ✅ supported | ✅ |  |
| `create_order_v3_order_post` | `POST /v3/order` | ✅ supported | ✅ |  |
| `get_area_info_v3_order_area_info_get` | `GET /v3/order/area/info` | ✅ supported | ✅ |  |
| `get_psc_info_v3_order_psc_info_get` | `GET /v3/order/psc/info` | ✅ supported | ✅ |  |
| `get_phlebotomy_appointment_availability_v3_order_phlebotomy_appointment_availability_post` | `POST /v3/order/phlebotomy/appointment/availability` | ✅ supported | ❌ disabled | availability slots are provider-side data whose values shift between sandbox calls; covered by the mock-internal scheduling property suite instead |
| `get_phlebotomy_appointment_cancellation_reason_v3_order_phlebotomy_appointment_cancellation_reasons_get` | `GET /v3/order/phlebotomy/appointment/cancellation-reasons` | ✅ supported | ✅ |  |
| `get_psc_appointment_availability_v3_order_psc_appointment_availability_post` | `POST /v3/order/psc/appointment/availability` | ✅ supported | ❌ disabled | availability slots are provider-side data whose values shift between sandbox calls; covered by the mock-internal scheduling property suite instead |
| `get_psc_appointment_cancellation_reason_v3_order_psc_appointment_cancellation_reasons_get` | `GET /v3/order/psc/appointment/cancellation-reasons` | ✅ supported | ✅ |  |
| `get_phlebotomy_appointment_v3_order__order_id__phlebotomy_appointment_get` | `GET /v3/order/{order_id}/phlebotomy/appointment` | ✅ supported | ❌ disabled | appointment payloads embed provider-side slot data; covered by the mock-internal scheduling property suite instead |
| `book_phlebotomy_appointment_v3_order__order_id__phlebotomy_appointment_book_post` | `POST /v3/order/{order_id}/phlebotomy/appointment/book` | ✅ supported | ❌ disabled | booking depends on live provider slot state; covered by the mock-internal scheduling property suite instead |
| `reschedule_phlebotomy_appointment_v3_order__order_id__phlebotomy_appointment_reschedule_patch` | `PATCH /v3/order/{order_id}/phlebotomy/appointment/reschedule` | ✅ supported | ❌ disabled | rescheduling depends on live provider slot state; covered by the mock-internal scheduling property suite instead |
| `cancel_phlebotomy_appointment_v3_order__order_id__phlebotomy_appointment_cancel_patch` | `PATCH /v3/order/{order_id}/phlebotomy/appointment/cancel` | ✅ supported | ❌ disabled | cancellation depends on live provider appointment state; covered by the mock-internal scheduling property suite instead |
| `get_psc_appointment_v3_order__order_id__psc_appointment_get` | `GET /v3/order/{order_id}/psc/appointment` | ✅ supported | ❌ disabled | appointment payloads embed provider-side slot data; covered by the mock-internal scheduling property suite instead |
| `book_psc_appointment_v3_order__order_id__psc_appointment_book_post` | `POST /v3/order/{order_id}/psc/appointment/book` | ✅ supported | ❌ disabled | booking depends on live provider slot state; covered by the mock-internal scheduling property suite instead |
| `reschedule_psc_appointment_v3_order__order_id__psc_appointment_reschedule_patch` | `PATCH /v3/order/{order_id}/psc/appointment/reschedule` | ✅ supported | ❌ disabled | rescheduling depends on live provider slot state; covered by the mock-internal scheduling property suite instead |
| `cancel_psc_appointment_v3_order__order_id__psc_appointment_cancel_patch` | `PATCH /v3/order/{order_id}/psc/appointment/cancel` | ✅ supported | ❌ disabled | cancellation depends on live provider appointment state; covered by the mock-internal scheduling property suite instead |
| `get_order_v3_order__order_id__get` | `GET /v3/order/{order_id}` | ✅ supported | ✅ |  |
| `cancel_order_v3_order__order_id__cancel_post` | `POST /v3/order/{order_id}/cancel` | ✅ supported | ✅ |  |
| `simulate_order_v3_order__order_id__test_post` | `POST /v3/order/{order_id}/test` | ✅ supported | ✅ |  |
| `get_result_raw_v3_order__order_id__result_get` | `GET /v3/order/{order_id}/result` | ✅ supported | ❌ disabled | results carry provider-side specimen data; covered by the mock-internal results property suite instead |
| `get_result_metadata_v3_order__order_id__result_metadata_get` | `GET /v3/order/{order_id}/result/metadata` | ✅ supported | ✅ |  |
| `get_result_pdf_v3_order__order_id__result_pdf_get` | `GET /v3/order/{order_id}/result/pdf` | ✅ supported | ❌ disabled | PDF bytes are provider-rendered; compared by shape (byteLength) only in the scenario script |
| `get_order_requisition_pdf_v3_order__order_id__requisition_pdf_get` | `GET /v3/order/{order_id}/requisition/pdf` | ✅ supported | ❌ disabled | PDF bytes are provider-rendered; compared by shape (byteLength) only in the scenario script |
| `get_orders_v3_orders_get` | `GET /v3/orders` | ✅ supported | ✅ |  |
| `get_order_transaction_v3_order_transaction__transaction_id__get` | `GET /v3/order_transaction/{transaction_id}` | ✅ supported | ❌ disabled | order transactions are not available to the sandbox team (feature not available) |
| `get_order_transaction_result_v3_order_transaction__transaction_id__result_get` | `GET /v3/order_transaction/{transaction_id}/result` | ✅ supported | ❌ disabled | lab results are not available to the sandbox team (feature not available) |
