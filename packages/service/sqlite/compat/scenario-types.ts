/** Construct-level drop-in parity catalog types. */

export const SECTION_CODES = [
  "TOK",
  "PAR",
  "TYP",
  "EXP",
  "FUN",
  "DAT",
  "JSN",
  "AGG",
  "WIN",
  "SEL",
  "JOI",
  "CTE",
  "DDL",
  "DML",
  "CON",
  "TRG",
  "TXN",
  "PRG",
  "COL",
  "FTS",
  "ATT",
  "API",
  "SNP",
  "DET",
  "ERR",
  "UNI",
  "LIM",
  "FZZ",
  "ECO",
] as const;

export type SectionCode = (typeof SECTION_CODES)[number];

export type ScenarioKind = "differential" | "documented_divergence" | "fuzz" | "property" | "ecosystem";

export type ProofStrength = "proves" | "smoke";

export interface Scenario {
  id: string;
  title: string;
  kind: ScenarioKind;
  evidence: string[];
  notes?: string;
  divergenceId?: string;
  strength?: ProofStrength;
}

export interface CatalogSection {
  code: SectionCode;
  title: string;
  promoted: boolean;
  scenarios: Scenario[];
}

/** IDs look like `TOK-01`, `WIN-frame-04`, `DET-negzero-01`. */
export const SCENARIO_ID_RE = /^([A-Z]{3})(?:-[a-z0-9]+)*-\d{2,}$/;

export function catalogTestFile(code: SectionCode): string {
  return `tests/contract/catalog/${code.toLowerCase()}.test.ts`;
}
