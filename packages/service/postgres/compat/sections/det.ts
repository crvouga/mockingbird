import { type CatalogSection, section } from "../scenario-types.ts";

const D = "documented_divergence" as const;
const DET_NOTE = "deterministic random/now by design";
const EXTRA = ["tests/contract/determinism/"];

const DIV = "deterministic-runtime";

export const DET_SECTION: CatalogSection = section("DET", "Determinism invariants", true, [
  ["seed-01", "same seed identical random streams", D, DET_NOTE, EXTRA, DIV],
  ["seed-02", "different seeds diverge", D, DET_NOTE, EXTRA, DIV],
  ["now-01", "now() fixed to 2000-01-01 by default", D, DET_NOTE, EXTRA, DIV],
  ["now-02", "injectable clock overrides now", D, DET_NOTE, EXTRA, DIV],
  ["uuid-01", "gen_random_uuid deterministic under seed", D, DET_NOTE, EXTRA, DIV],
  ["rb-01", "PRNG rolls back with ROLLBACK", D, DET_NOTE, EXTRA, DIV],
  ["snap-01", "random() stream continues after restore", D, DET_NOTE, EXTRA, DIV],
  ["setseed-01", "setseed + random repeatable", D, DET_NOTE, EXTRA, DIV],
  ["scan-01", "scan and aggregation order stable across restore", D, DET_NOTE, EXTRA, DIV],
  ["negzero-01", "float8 -0 keeps its sign like PostgreSQL"],
]);
