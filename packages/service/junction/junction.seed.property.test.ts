import { describe, expect, test } from "bun:test"
import { seedParity } from "@crvouga/mockingbird-parity"
import { fcParameters } from "@crvouga/mockingbird-testing"
import { document, JunctionAPI } from "./src/index.js"
import { prefetchGevitiQaObservations } from "./src/prefetch-qa.js"
import { reshapeGevitiQaGeoCommand } from "./src/reshape-qa.js"

const params = fcParameters(process.env)
const MOCK_HOST = "mock.junction.local"
const AUTH = { "x-vital-api-key": "sk_us_mockingbird" }
const now = () => 1_700_000_000_000

/** Full Geviti-facing Junction surface for offline monkey confidence. */
const OFFLINE_OPS = [
  "create_user_v2_user_post",
  "get_user_v2_user__user_id__get",
  "get_user_by_client_user_id_v2_user_resolve__client_user_id__get",
  "patch_user_info_v2_user__user_id__info_patch",
  "get_paginated_lab_tests_for_team_v3_lab_test_get",
  "get_labs_v3_lab_tests_labs_get",
  "create_order_v3_order_post",
  "get_order_v3_order__order_id__get",
  "cancel_order_v3_order__order_id__cancel_post",
  "simulate_order_v3_order__order_id__test_post",
  "get_result_metadata_v3_order__order_id__result_metadata_get",
  "get_result_raw_v3_order__order_id__result_get",
  "get_orders_v3_orders_get",
  "get_area_info_v3_order_area_info_get",
  "get_psc_info_v3_order_psc_info_get",
  "get_phlebotomy_appointment_availability_v3_order_phlebotomy_appointment_availability_post",
  "book_phlebotomy_appointment_v3_order__order_id__phlebotomy_appointment_book_post",
  "get_phlebotomy_appointment_v3_order__order_id__phlebotomy_appointment_get",
  "reschedule_phlebotomy_appointment_v3_order__order_id__phlebotomy_appointment_reschedule_patch",
  "cancel_phlebotomy_appointment_v3_order__order_id__phlebotomy_appointment_cancel_patch",
  "get_psc_appointment_availability_v3_order_psc_appointment_availability_post",
  "get_phlebotomy_appointment_cancellation_reason_v3_order_phlebotomy_appointment_cancellation_reasons_get",
  "get_psc_appointment_cancellation_reason_v3_order_psc_appointment_cancellation_reasons_get",
] as const

const FORCE_INCLUDE = [
  "get_result_raw_v3_order__order_id__result_get",
  "get_area_info_v3_order_area_info_get",
  "get_psc_info_v3_order_psc_info_get",
  "get_phlebotomy_appointment_availability_v3_order_phlebotomy_appointment_availability_post",
  "book_phlebotomy_appointment_v3_order__order_id__phlebotomy_appointment_book_post",
  "get_phlebotomy_appointment_v3_order__order_id__phlebotomy_appointment_get",
  "reschedule_phlebotomy_appointment_v3_order__order_id__phlebotomy_appointment_reschedule_patch",
  "cancel_phlebotomy_appointment_v3_order__order_id__phlebotomy_appointment_cancel_patch",
  "get_psc_appointment_availability_v3_order_psc_appointment_availability_post",
] as const

describe("JunctionAPI seedFrom", () => {
  test(
    "mock↔mock dynamic seedParity: full Geviti QA surface",
    async () => {
      const oracle = new JunctionAPI({ now })
      const report = await seedParity({
        provider: "junction",
        spec: document,
        explore: "dynamic",
        reshapeCommand: reshapeGevitiQaGeoCommand,
        real: {
          baseUrl: `https://${MOCK_HOST}`,
          allowedHosts: [MOCK_HOST],
          headers: () => AUTH,
          fetch: (request) => oracle.fetch(request),
        },
        mock: {
          create: () => new JunctionAPI({ now }),
          baseUrl: `https://${MOCK_HOST}`,
          headers: () => AUTH,
        },
        prefetchObservations: async ({ real, getCache }) => {
          await prefetchGevitiQaObservations({
            real,
            getCache,
            zips: ["85004", "85234", "11050", "90012", "10006", "96101", "92101"],
            labIds: [4, 6],
            minIntervalMs: 0,
            sleep: async () => {},
          })
        },
        seedMock: async ({ mock, real, getCache, table }) => {
          const target = mock as JunctionAPI
          const source = {
            fetch: (request: Request) => real.fetch(request),
            baseUrl: real.baseUrl,
            headers: AUTH,
          }
          await target.seedFrom(source, { getCache })
          const labTestIds = table
            .all()
            .filter((resource) => resource.type === "lab_test")
            .map((resource) => resource.ids.real ?? resource.ids.mock)
            .filter((id): id is string => typeof id === "string" && id.length > 0)
          await target.ensureLabTests(source, labTestIds)
          const orderIds = table
            .all()
            .filter((resource) => resource.type === "order")
            .map((resource) => resource.ids.real ?? resource.ids.mock)
            .filter((id): id is string => typeof id === "string" && id.length > 0)
          await target.ensureOrders(source, orderIds)
          for (const resource of table.all()) {
            if (resource.type !== "user" || resource.status !== "deleted") continue
            const id = resource.ids.real ?? resource.ids.mock
            if (id) target.markUserDeleted(id)
          }
        },
        cleanup: async () => {
          await oracle.reset()
        },
        only: [...OFFLINE_OPS],
        forceInclude: [...FORCE_INCLUDE],
        deletionTypes: {
          delete_user_v2_user__user_id__delete: ["user"],
          book_phlebotomy_appointment_v3_order__order_id__phlebotomy_appointment_book_post: [
            "booking_key",
          ],
          book_psc_appointment_v3_order__order_id__psc_appointment_book_post: ["booking_key"],
          reschedule_phlebotomy_appointment_v3_order__order_id__phlebotomy_appointment_reschedule_patch:
            ["booking_key"],
          reschedule_psc_appointment_v3_order__order_id__psc_appointment_reschedule_patch: [
            "booking_key",
          ],
        },
        invalidProbability: 0,
        missingProbability: 0,
        deletedRefProbability: 0,
        numRuns: params.numRuns ?? 50,
        warmupCommands: 12,
        compareCommands: 24,
        latencyToleranceMs: 2_000,
        shrink: false,
        ...(params.seed === undefined ? {} : { seed: params.seed }),
        env: process.env,
        sleep: async () => {},
        log: () => {},
      })
      expect(report.walks).toBeGreaterThan(0)
      expect(report.operations).toBeGreaterThan(0)
      const exercised = Object.keys(report.exercised)
      expect(exercised.some((id) => id.includes("create_user"))).toBe(true)
      expect(exercised.some((id) => id.includes("create_order") || id.includes("lab_test"))).toBe(
        true,
      )
    },
    { timeout: 180_000 },
  )
})
