import { expect } from "bun:test";
import type { SectionCode } from "../../../compat/scenario-types.ts";
import { SCENARIO_CATALOG } from "../../../compat/scenarios.ts";
import type { Database } from "../../../src/index.ts";
import { matrixBoth } from "../../harness/matrix.ts";
import type { CompareOptions } from "../../harness/normalize.ts";
import type { SqlValue } from "../../harness/types.ts";
import {
  divergence,
  errorParity,
  execParity,
  parity,
  parityTyped,
  queryErrorParity,
  sequenceParity,
  setupBoth,
} from "../helpers.ts";

export type CatalogCase =
  | {
      id: string;
      kind: "parity";
      setup?: string[];
      sql: string;
      typed?: boolean;
      params?: SqlValue[];
      ignoreColumnNames?: boolean;
    }
  | {
      id: string;
      kind: "error";
      setup?: string[];
      sql: string;
      query?: boolean;
      messageTier?: "A" | "B";
      notes?: string;
    }
  | { id: string; kind: "exec"; setup?: string[]; sql: string }
  | {
      id: string;
      kind: "sequence";
      setup?: string[];
      steps: Array<{ sql: string; query?: boolean }>;
      compareFinalState?: boolean;
    }
  | { id: string; kind: "divergence"; fn: (db: Database) => void };

export function runCatalog(code: SectionCode, cases: CatalogCase[]): void {
  const section = SCENARIO_CATALOG.find((entry) => entry.code === code);
  if (!section) throw new Error(`Unknown catalog section ${code}`);
  const byId = new Map(cases.map((entry) => [entry.id, entry]));
  for (const scenario of section.scenarios) {
    const spec = byId.get(scenario.id);
    if (!spec) throw new Error(`Missing catalog case for ${scenario.id}`);
    const name = `${scenario.id}: ${scenario.title}`;
    switch (spec.kind) {
      case "parity":
        if (spec.typed) parityTyped(name, spec.setup ?? [], spec.sql, spec.params);
        else {
          parity(name, spec.setup ?? [], spec.sql, spec.params, {
            ignoreColumnNames: spec.ignoreColumnNames ?? true,
          });
        }
        break;
      case "error": {
        if (spec.messageTier === "B" && !spec.notes) {
          throw new Error(`${spec.id}: Tier B errors require notes explaining why Tier A is impossible`);
        }
        if (spec.messageTier) {
          const options: CompareOptions = { messageTier: spec.messageTier, ignoreErrorPhase: true };
          if (spec.query) queryErrorParity(name, spec.setup ?? [], spec.sql, undefined, options);
          else errorParity(name, spec.setup ?? [], spec.sql, undefined, options);
        } else {
          matrixBoth(name, (memory, sqlite) => {
            setupBoth(memory, sqlite, spec.setup ?? []);
            const a = spec.query ? memory.query(spec.sql) : memory.exec(spec.sql);
            const b = spec.query ? sqlite.query(spec.sql) : sqlite.exec(spec.sql);
            expect(a.ok).toBe(false);
            expect(b.ok).toBe(false);
          });
        }
        break;
      }
      case "exec":
        execParity(name, spec.setup ?? [], spec.sql);
        break;
      case "sequence":
        sequenceParity(name, spec.setup ?? [], spec.steps, {
          compareFinalState: spec.compareFinalState === true,
        });
        break;
      case "divergence":
        divergence(scenario.id, scenario.title, spec.fn);
        break;
    }
  }
  for (const id of byId.keys()) {
    if (!section.scenarios.some((scenario) => scenario.id === id)) {
      throw new Error(`Catalog case ${id} is not in section ${code}`);
    }
  }
}
