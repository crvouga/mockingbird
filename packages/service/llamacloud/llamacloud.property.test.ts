import { describe, expect, test } from "bun:test"
import { ParityError, parity } from "@crvouga/mockingbird-parity"
import { fcParameters } from "@crvouga/mockingbird-testing"
import fc from "fast-check"
import { document, LlamaCloudAPI, supportedOperationIds } from "./src/index.js"

const params = fcParameters(process.env)
const MOCK_HOST = "mock.llamacloud.local"
const now = () => 1_700_000_000_000
const auth = { authorization: "Bearer llx-parity" }

describe("LlamaCloudAPI", () => {
  test(
    "self-parity: independent instances agree on every random walk and conform to the spec",
    async () => {
      const reference = new LlamaCloudAPI({ now })
      const report = await parity({
        provider: "llamacloud",
        spec: document,
        real: {
          baseUrl: `https://${MOCK_HOST}`,
          allowedHosts: [MOCK_HOST],
          headers: () => auth,
          fetch: (request) => reference.fetch(request),
        },
        mock: {
          create: () => new LlamaCloudAPI({ now }),
          baseUrl: `https://${MOCK_HOST}`,
          headers: () => auth,
        },
        cleanup: async () => {
          await reference.reset()
        },
        includeUnsafe: true,
        numRuns: params.numRuns ?? 150,
        maxCommands: 20,
        // Everything below the pipeline needs a pipeline id from an earlier search in the same
        // walk, and document reads/deletes need a document from an earlier write.
        weights: {
          ListProjects: 0.5,
          GetPipeline: 2,
          RunSearch: 2,
          ListPipelineDocuments: 2,
          CreateBatchPipelineDocuments: 2,
          UpsertBatchPipelineDocuments: 2,
          GetPipelineDocument: 4,
          DeletePipelineDocument: 4,
        },
        coverageBias: 3,
        latencyToleranceMs: 1_000,
        ...(params.seed === undefined ? {} : { seed: params.seed }),
        env: process.env,
        sleep: async () => {},
        log: () => {},
      })
      expect(report.walks).toBeGreaterThan(0)
      // Every operation, including document writes and retrieval, is reached by the walks.
      expect(Object.keys(report.exercised).sort()).toEqual([...supportedOperationIds].sort())
    },
    { timeout: 120_000 },
  )

  test(
    "a deliberately divergent instance is caught and shrunk",
    async () => {
      await fc.assert(
        fc.asyncProperty(fc.integer(), async (seed) => {
          const reference = new LlamaCloudAPI({ now })
          const faulty = () => {
            const api = new LlamaCloudAPI({ now })
            return {
              fetch: async (request: Request) => {
                const response = await api.fetch(request)
                if (new URL(request.url).pathname !== "/api/v1/pipelines") return response
                // Every search answers one pipeline too many.
                const body = (await response.json()) as unknown[]
                const extra = {
                  id: "diverged",
                  name: "diverged",
                  project_id: "diverged",
                  embedding_config: { type: "MANAGED_OPENAI_EMBEDDING" },
                }
                return Response.json([...body, extra], { status: response.status })
              },
            }
          }
          const failure = await parity({
            provider: "llamacloud",
            spec: document,
            real: {
              baseUrl: `https://${MOCK_HOST}`,
              allowedHosts: [MOCK_HOST],
              headers: () => auth,
              fetch: (r) => reference.fetch(r),
            },
            mock: { create: faulty, baseUrl: `https://${MOCK_HOST}`, headers: () => auth },
            cleanup: async () => {
              await reference.reset()
            },
            only: ["SearchPipelines"],
            numRuns: 10,
            maxCommands: 3,
            seed,
            invalidProbability: 0,
            latencyToleranceMs: 1_000,
            sleep: async () => {},
            log: () => {},
          }).then(
            () => undefined,
            (error: unknown) => error,
          )
          expect(failure).toBeInstanceOf(ParityError)
        }),
        { ...params, numRuns: 3 },
      )
    },
    { timeout: 60_000 },
  )
})
