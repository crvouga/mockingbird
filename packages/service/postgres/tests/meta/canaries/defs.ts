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
    find: "      rows = rows.slice(0, end);",
    replace: "      rows = rows.slice(0, end + 1);",
    probe: ["tests/contract/limits"],
  },
  {
    id: "null-eq-true",
    description: "NULL comparisons return true instead of unknown",
    file: "src/expressions/operators.ts",
    find: 'if (l.v === null || r.v === null) return tv("bool", null);',
    replace: 'if (l.v === null || r.v === null) return tv("bool", true);',
    probe: ["tests/contract/null"],
  },
  {
    id: "unique-skip",
    description: "UNIQUE / PRIMARY KEY enforcement is a no-op",
    file: "src/indexes/index.ts",
    find: "    const existing = this.entries.get(key);\n    if (!existing) return;\n    for (const i of existing) {\n      if (rowIdx === undefined || i !== rowIdx) {",
    replace:
      "    void key; void rowIdx; if (false) {\n    const existing = this.entries.get(key);\n    if (!existing) return;\n    for (const i of existing) {\n      if (rowIdx === undefined || i !== rowIdx) {",
    probe: ["tests/contract/constraints", "tests/contract/on-conflict"],
  },
  {
    id: "in-empty-null",
    description: "IN over an empty set returns NULL instead of false",
    file: "src/expressions/eval.ts",
    find: "  if (found) result = true;\n  else if (sawNull) result = null;\n  else result = false;",
    replace: "  if (found) result = true;\n  else result = null;",
    probe: ["tests/contract/aggregates/empty-groups.test.ts", "tests/contract/subqueries"],
  },
  {
    id: "numeric-add-scale",
    description: "numeric addition unifies to the smaller display scale",
    file: "src/types/numeric.ts",
    find: "  const scale = Math.max(a.dscale, b.dscale);\n  return makeNumeric(a.coef * pow10(scale - a.dscale) + b.coef * pow10(scale - b.dscale), scale);",
    replace:
      "  const scale = Math.min(a.dscale, b.dscale);\n  return makeNumeric(a.coef * pow10(scale - a.dscale) + b.coef * pow10(scale - b.dscale), scale);",
    probe: ["tests/contract/numeric"],
  },
  {
    id: "rowcount-zero",
    description: "Statement.run always reports rowCount 0",
    file: "src/api/statement.ts",
    find: "    return { rowCount: res.rowCount, command: res.command };",
    replace: "    return { rowCount: 0, command: res.command };",
    probe: ["tests/contract/api"],
  },
  {
    id: "jsonb-compare-float",
    description: "jsonb numeric compare uses float64 instead of numericCmp",
    file: "src/types/jsonb.ts",
    find: "      return numericCmp(numericStripTrailingZeros(a.v), numericStripTrailingZeros(bb.v));",
    replace:
      "      { const ta = numericText(numericStripTrailingZeros(a.v)); const tb = numericText(numericStripTrailingZeros(bb.v)); if (ta === tb) return 0; const fa = Number(ta); const fb = Number(tb); if (fa !== fb) return fa < fb ? -1 : 1; return ta < tb ? -1 : 1; }",
    probe: ["tests/contract/jsonb/compare-order.test.ts"],
  },
  {
    id: "numeric-mul-uncapped",
    description: "numeric multiplication skips display-scale cap",
    file: "src/types/numeric.ts",
    find: "  if (dscale > MAX_DISPLAY_SCALE) {\n    coef = roundToScale(coef, dscale, MAX_DISPLAY_SCALE);\n    dscale = MAX_DISPLAY_SCALE;\n  }\n  return makeNumeric(coef, dscale);",
    replace: '  return { kind: "numeric", coef, dscale, special: null };',
    probe: ["tests/meta/canaries/numeric-mul-cap.unit.test.ts"],
  },
];
