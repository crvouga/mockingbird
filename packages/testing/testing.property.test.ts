import { expect, test } from "bun:test"
import fc from "fast-check"
import { fcParameters } from "./src/index.js"

test("fcParameters parses integers and ignores blanks", () => {
  fc.assert(
    fc.property(fc.integer(), fc.integer({ min: 1 }), (seed, numRuns) => {
      expect(fcParameters({ FC_SEED: String(seed), FC_NUM_RUNS: String(numRuns) })).toEqual({
        seed,
        numRuns,
      })
      expect(fcParameters({ FC_SEED: "", FC_NUM_RUNS: undefined })).toEqual({})
    }),
  )
})
