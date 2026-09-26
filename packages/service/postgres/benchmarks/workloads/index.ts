import type { BenchSpec } from "../harness/types.ts";
import { appSpecs } from "./app.ts";
import { analyticsSpecs, indexSpecs, joinSpecs, startupSpecs, transactionSpecs } from "./engine-ops.ts";
import { isolationSpecs } from "./isolation.ts";
import { jsonSpecs, tsearchSpecs } from "./json-tsearch.ts";
import { largeSpecs } from "./large.ts";
import { memoryFootprintSpecs } from "./memory-footprint.ts";
import { microSpecs } from "./micro.ts";
import { snapshotSpecs } from "./snapshots.ts";

export function allSpecs(): BenchSpec[] {
  return [
    ...startupSpecs(),
    ...microSpecs(),
    ...appSpecs(),
    ...largeSpecs(),
    ...memoryFootprintSpecs(),
    ...jsonSpecs(),
    ...tsearchSpecs(),
    ...analyticsSpecs(),
    ...transactionSpecs(),
    ...indexSpecs(),
    ...joinSpecs(),
    ...snapshotSpecs(),
    ...isolationSpecs(),
  ];
}
