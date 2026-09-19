/**
 * Deliberate sabotages. Each must cause the listed probe tests to fail.
 * Restored after every run by scripts/run-canaries.ts.
 *
 * Survivors are documented proof holes in the differential suite.
 */
export interface Canary {
  id: string;
  description: string;
  file: string;
  find: string;
  replace: string;
  /** Focused bun test paths that exercise the sabotaged code. */
  probe: string[];
}

export const CANARIES: Canary[] = [
  {
    id: "limit-off-by-one",
    description: "LIMIT returns one extra row (main select path)",
    file: "src/executor/select.ts",
    find: "output = output.slice(offset, limit < 0 ? undefined : offset + limit);",
    replace: "output = output.slice(offset, limit < 0 ? undefined : offset + limit + 1);",
    probe: ["tests/contract/limits"],
  },
  {
    id: "null-eq-true",
    description: "NULL comparisons return true instead of unknown",
    file: "src/expressions/eval.ts",
    find: "const comparison = collation ? compareWithCollation(left, right, collation) : compareSql(left, right);\n  if (comparison === null) return null;",
    replace:
      "const comparison = collation ? compareWithCollation(left, right, collation) : compareSql(left, right);\n  if (comparison === null) return booleanValue(true);",
    probe: ["tests/contract/null"],
  },
  {
    id: "unique-skip",
    description: "UNIQUE index checkUnique is a no-op",
    file: "src/indexes/index.ts",
    find: "if (unique) this.checkUnique(values, rowid);",
    replace: "if (false && unique) this.checkUnique(values, rowid);",
    probe: ["tests/contract/unique", "tests/contract/conflicts"],
  },
  {
    id: "affinity-integer-skip",
    description: "INTEGER affinity no longer coerces numeric text",
    file: "src/types/value.ts",
    find: 'case "INTEGER": {\n      if (value instanceof Uint8Array) return value;\n      const n = coerceToNumber(value);\n      if (n === null) return value;',
    replace:
      'case "INTEGER": {\n      if (value instanceof Uint8Array) return value;\n      const n = null;\n      if (n === null) return value;',
    probe: ["tests/contract/types/affinity.test.ts", "tests/contract/types/affinity-matrix.test.ts"],
  },
  {
    id: "order-class-flip",
    description: "Cross-type ORDER BY class order flipped",
    file: "src/types/value.ts",
    find: "if (ca !== cb) return ca < cb ? -1 : 1;",
    replace: "if (ca !== cb) return ca < cb ? 1 : -1;",
    probe: ["tests/contract/ordering/mixed-types.test.ts"],
  },
  {
    id: "changes-zero",
    description: "recordChange always records zero changes",
    file: "src/storage/database-state.ts",
    find: "this.changes = count;\n    this.totalChanges += count;",
    replace: "this.changes = 0;\n    this.totalChanges += 0;",
    probe: ["tests/contract/api/freeze.test.ts", "tests/contract/integration/orm-crud.test.ts"],
  },
];
