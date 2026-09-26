import { expect } from "bun:test";
import type { CatalogSection } from "../../../compat/scenario-types.ts";
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
      options?: CompareOptions;
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
      steps: Array<{ sql: string; query?: boolean; params?: SqlValue[] }>;
      compareFinalState?: boolean;
    }
  | { id: string; kind: "divergence"; fn: (db: Database) => void | Promise<void> };

/**
 * Execute every scenario of a catalog section. Each scenario ID must have
 * exactly one case, and every case must belong to the section — the catalog
 * and its executable proof cannot drift apart.
 */
export function runCatalog(section: CatalogSection, cases: CatalogCase[]): void {
  const byId = new Map(cases.map((entry) => [entry.id, entry]));
  if (byId.size !== cases.length) throw new Error(`duplicate case ids in section ${section.code}`);
  for (const scenario of section.scenarios) {
    const spec = byId.get(scenario.id);
    if (!spec) throw new Error(`Missing catalog case for ${scenario.id}`);
    const name = `${scenario.id}: ${scenario.title}`;
    switch (spec.kind) {
      case "parity":
        if (spec.typed) parityTyped(name, spec.setup ?? [], spec.sql, spec.params);
        else parity(name, spec.setup ?? [], spec.sql, spec.params, spec.options);
        break;
      case "error": {
        if (spec.messageTier === "B" && !spec.notes) {
          throw new Error(`${spec.id}: Tier B errors require notes explaining why Tier A is impossible`);
        }
        const options: CompareOptions = { messageTier: spec.messageTier ?? "B", ignoreErrorPhase: true };
        if (spec.messageTier === "A") {
          if (spec.query) queryErrorParity(name, spec.setup ?? [], spec.sql, undefined, options);
          else errorParity(name, spec.setup ?? [], spec.sql, undefined, options);
        } else {
          // Tier B: both must fail with the same SQLSTATE-derived category.
          matrixBoth(name, async (memory, postgres) => {
            await setupBoth(memory, postgres, spec.setup ?? []);
            const a = spec.query ? await memory.query(spec.sql) : await memory.exec(spec.sql);
            const b = spec.query ? await postgres.query(spec.sql) : await postgres.exec(spec.sql);
            expect(a.ok, `memory unexpectedly succeeded: ${spec.sql}`).toBe(false);
            expect(b.ok, `postgres unexpectedly succeeded: ${spec.sql}`).toBe(false);
            expect(a.error?.category).toBe(b.error?.category as never);
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
        if (scenario.kind === "differential") {
          throw new Error(`${scenario.id}: divergence case requires a non-differential scenario kind`);
        }
        divergence(scenario.id, scenario.title, spec.fn);
        break;
    }
  }
  for (const id of byId.keys()) {
    if (!section.scenarios.some((scenario) => scenario.id === id)) {
      throw new Error(`Catalog case ${id} is not in section ${section.code}`);
    }
  }
}
