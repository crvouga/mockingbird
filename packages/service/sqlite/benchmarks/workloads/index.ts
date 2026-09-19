import { appSpecs } from "./app.ts";
import { compareAllSpecs } from "./compare-js.ts";
import { indexSpecs, joinSpecs, parserSpecs, startupSpecs, transactionSpecs } from "./engine-ops.ts";
import { hotspotSpecs } from "./hotspots.ts";
import { ftsSpecs, jsonSpecs } from "./json-fts.ts";
import { largeSpecs } from "./large.ts";
import { memoryFootprintSpecs } from "./memory-footprint.ts";
import { microSpecs } from "./micro.ts";
import { isolationSpecs } from "./isolation.ts";
import { snapshotSpecs } from "./snapshots.ts";
import type { BenchSpec } from "../harness/types.ts";

export function allSpecs(): BenchSpec[] {
  return [
    ...startupSpecs(),
    ...parserSpecs(),
    ...microSpecs(),
    ...compareAllSpecs(),
    ...appSpecs(),
    ...largeSpecs(),
    ...memoryFootprintSpecs(),
    ...jsonSpecs(),
    ...ftsSpecs(),
    ...transactionSpecs(),
    ...indexSpecs(),
    ...joinSpecs(),
    ...hotspotSpecs(),
    ...snapshotSpecs(),
    ...isolationSpecs(),
  ];
}
