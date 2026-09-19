# @crvouga/mockingbird-commands

Stateful [fast-check](https://fast-check.dev/) command generation for OpenAPI-driven random API walks. It plans which operations are eligible (from `x-mockingbird-*` annotations), generates shrink-friendly `LogicalCommand`s whose resource ids are symbolic placeholders, and turns a command into a concrete Fetch `Request` for either side of a comparison. You only need this directly if you are building your own walk executor — [`@crvouga/mockingbird-parity`](https://www.npmjs.com/package/@crvouga/mockingbird-parity) uses it for you.

## Install

```bash
npm install -D @crvouga/mockingbird-commands fast-check
```

`fast-check` 4.x is a dependency (pinned `4.9.0`); install the same major to run the arbitraries in your own properties. ESM only, Node >= 22 or Bun >= 1.2.

## Usage

```ts
import {
  commandArbitrary,
  concretize,
  describeCommand,
  isEligible,
  planOperations,
  toRequest,
} from "@crvouga/mockingbird-commands"
import { ResourceTable } from "@crvouga/mockingbird-model"
import { parseOpenAPIDocument } from "@crvouga/mockingbird-openapi"
import fc from "fast-check"

const note = {
  type: "object",
  properties: { id: { type: "string", "x-mockingbird-resource": { type: "note", identity: true } } },
}
const ok = { "200": { description: "ok", content: { "application/json": { schema: note } } } }
const document = parseOpenAPIDocument({
  openapi: "3.1.0",
  info: { title: "notes", version: "1" },
  paths: {
    "/notes": {
      post: {
        operationId: "createNote",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { type: "object", properties: { text: { type: "string", maxLength: 20 } } },
            },
          },
        },
        responses: ok,
      },
    },
    "/notes/{note}": {
      get: {
        operationId: "getNote",
        parameters: [
          {
            name: "note",
            in: "path",
            required: true,
            schema: { type: "string" },
            "x-mockingbird-resource-ref": { type: "note" },
          },
        ],
        responses: ok,
      },
    },
  },
})

const plans = planOperations(document)
console.log(plans.map((p) => [p.operation.operationId, p.requires, p.produces]))
// [["createNote", [], ["note"]], ["getNote", ["note"], ["note"]]]

// Pretend one note already exists on both sides.
const table = new ResourceTable()
table.register("note", { real: "note_live_1", mock: "note_1" })
const scope = { runId: "run-1", walkStartUnix: Math.floor(Date.now() / 1000) }

const commands = fc.sample(commandArbitrary({ document, plans }), { numRuns: 5, seed: 42 })
for (const command of commands) {
  if (!isEligible(command, (type) => table.count(type))) continue
  const plan = plans.find((p) => p.operation.operationId === command.operationId)
  if (!plan) continue
  const request = toRequest(concretize(command, plan, table, "mock", scope), "https://mock.local")
  console.log(describeCommand(command), "->", request.method, request.url)
}
```

## API

Planning and generation:

| Export | Signature | Description |
| --- | --- | --- |
| `planOperations` | `(document, options?: PlanOptions) => OperationPlan[]` | Every operation the runner may generate: skips `supported: false`, `parity.enabled: false` and (unless `includeUnsafe`) `parity.safe: false`. `PlanOptions`: `includeUnsafe?`, `only?: string[]`, `forceInclude?: string[]` (include even when `parity.enabled` is false or unsafe). |
| `commandArbitrary` | `(options: CommandArbitraryOptions) => fc.Arbitrary<LogicalCommand>` | Commands over all plans. Producers with no requirements get weight 2, others 1, unless `weights` overrides. Throws `RangeError` when `plans` is empty. |
| `planCommandArbitrary` | `(plan, options: CommandArbitraryOptions) => fc.Arbitrary<LogicalCommand>` | Commands for one operation. Path, required and scope-carrying parameters are always present; cookie params and `x-mockingbird-unsupported` nodes are omitted. JSON and form bodies are preferred. |
| `referencedTypes` | `(command) => string[]` | Resource types the command references through `ref` placeholders. |
| `isEligible` | `(command, count: (type) => number) => boolean` | True when every referenced type has at least one instance. Use as the fast-check `check`. |
| `describeCommand` | `(command) => string` | Short one-line description used in shrunk reproductions. |

`CommandArbitraryOptions`: `document`, `plans`, `invalidProbability` (default `0.15`, chance a body violates one constraint), `missingProbability` (default `0.08`, chance a reference is a well-formed nonexistent id), `optionalProbability` (default `0.5`), `bodyProbability` (default `0.9`, chance an optional body is sent), `weights` (operationId -> relative weight), `coverageBias` (default `1` = off) and `coverage` (operationId -> count; untouched operations are weighted up by `coverageBias`).

Executing:

| Export | Signature | Description |
| --- | --- | --- |
| `concretize` | `(command, plan, table, side, scope: Scope, deletedRefProbability = 0) => ConcreteRequest` | Resolve placeholders for one side and encode path, query (form-style for objects), headers and body. |
| `resolveForSide` | `(value, table, side, scope, deletedRefProbability = 0) => unknown` | Resolve placeholders in any value. Throws `UnresolvedReferenceError` when a `ref` has no bound id on that side. |
| `toRequest` | `(request: ConcreteRequest, baseUrl, extraHeaders = {}) => Request` | Build a Fetch `Request`. `baseUrl`'s path is kept as a prefix; its query string is dropped. `extraHeaders` override generated headers; `content-type` is always the body's. |
| `UnresolvedReferenceError` | `class extends Error { type; side }` | See `resolveForSide`. |

Guided (non-fast-check) exploration, used by `seedParity`'s `explore: "dynamic"` mode:

| Export | Signature | Description |
| --- | --- | --- |
| `sampleGuidedCommand` | `(state: ExploreState, options: GuidedSampleOptions, rng) => LogicalCommand \| undefined` | Pick a plan by dynamic weight, sample one command, retry up to `maxAttempts` (24) until eligible. |
| `generateGuidedWalk` | `(options: GuidedSampleOptions & { steps; seed; phase; observationCacheSize? }, hooks?: GuidedWalkHooks) => LogicalCommand[]` | Build a walk without executing it. Without `hooks.count`, every resource count is 0, so only commands without references are produced. |
| `weightPlans` | `(plans, state, weightFn = defaultDynamicWeight) => WeightedPlan[]` | Plans with positive weight. |
| `defaultDynamicWeight` | `DynamicWeightFn` | Producers early, consumers once resources exist, continuation boosts, coverage bias, anti-repeat dampening. Contains Junction-specific rules. |
| `JUNCTION_CONTINUATIONS` | `Record<operationId, Record<operationId, number>>` | "After A, boost B" table for the Junction (Vital) API used by `defaultDynamicWeight`. |
| `pickWeightedIndex` | `(weighted, unit: number) => number` | Index for `unit` in `[0, 1)`; throws on an empty list. |
| `createExploreRng` | `(seed) => { next(): number; nextInt(max): number }` | Deterministic Mulberry32 PRNG. |
| `pushHistory` | `(history: string[], operationId, cap = 12) => void` | Append and cap. |
| `resourceCountsFrom` | `(count, types) => Record<string, number>` | Snapshot counts for the given types. |
| `resourceTypesOf` | `(plans) => string[]` | Every type any plan requires or produces. |

Exported types: `OperationPlan` (`{ operation, metadata, requires, produces, body }`), `PlanOptions`, `RequestBodyPlan`, `LogicalCommand` (`{ operationId, parameters, body, mediaType, invalid }`), `CommandArbitraryOptions`, `ConcreteRequest` (`{ method, path, query, headers, body }`), `Scope` (`{ runId; walkStartUnix }`), `ExploreState`, `ExploreRng`, `WeightContext`, `WeightedPlan`, `DynamicWeightFn`, `GuidedSampleOptions` (command options minus `weights`, plus `weightFn?`, `maxAttempts?`, `reshapeCommand?`), `GuidedWalkHooks` (`{ afterCommand?, count? }`).

## Related

- [`@crvouga/mockingbird-model`](https://www.npmjs.com/package/@crvouga/mockingbird-model) — `ResourceTable` and placeholders.
- [`@crvouga/mockingbird-openapi-arbitrary`](https://www.npmjs.com/package/@crvouga/mockingbird-openapi-arbitrary) — the value generators underneath.
- [`@crvouga/mockingbird-parity`](https://www.npmjs.com/package/@crvouga/mockingbird-parity) — runs these commands against a real API and a mock.

Part of [mockingbird](https://github.com/crvouga/mockingbird) — agent integration guide: [`@crvouga/mockingbird`](https://github.com/crvouga/mockingbird/tree/main/packages/facade#readme).
