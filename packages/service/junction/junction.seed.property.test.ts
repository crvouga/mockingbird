import { describe, expect, test } from "bun:test"
import { seedParity } from "@crvouga/mockingbird-parity"
import { fcParameters } from "@crvouga/mockingbird-testing"
import { document, JunctionAPI } from "./src/index.js"

const params = fcParameters(process.env)
const MOCK_HOST = "mock.junction.local"
const AUTH = { "x-vital-api-key": "sk_us_mockingbird" }
const now = () => 1_700_000_000_000

describe("JunctionAPI seedFrom", () => {
  test(
    "mock↔mock seedParity: warmup N on oracle mock, seed target, lockstep M",
    async () => {
      const oracle = new JunctionAPI({ now })
      const report = await seedParity({
        provider: "junction",
        spec: document,
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
        seedMock: async ({ mock, real, getCache }) => {
          const target = mock as JunctionAPI
          await target.seedFrom(
            {
              fetch: (request) => real.fetch(request),
              baseUrl: real.baseUrl,
              headers: AUTH,
            },
            { getCache },
          )
        },
        cleanup: async () => {
          await oracle.reset()
        },
        only: [
          "create_user_v2_user_post",
          "get_user_v2_user__user_id__get",
          "delete_user_v2_user__user_id__delete",
          "get_paginated_lab_tests_for_team_v3_lab_test_get",
          "get_labs_v3_lab_tests_labs_get",
          "create_order_v3_order_post",
          "get_order_v3_order__order_id__get",
          "get_orders_v3_orders_get",
          "simulate_order_v3_order__order_id__test_post",
          "get_result_metadata_v3_order__order_id__result_metadata_get",
        ],
        invalidProbability: 0,
        numRuns: params.numRuns ?? 40,
        warmupCommands: 8,
        compareCommands: 12,
        coverageBias: 10,
        latencyToleranceMs: 2_000,
        shrink: false,
        ...(params.seed === undefined ? {} : { seed: params.seed }),
        env: process.env,
        sleep: async () => {},
        log: () => {},
      })
      expect(report.walks).toBeGreaterThan(0)
      expect(report.operations).toBeGreaterThan(0)
    },
    { timeout: 60_000 },
  )
})
