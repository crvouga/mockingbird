/** Construct-level drop-in parity catalog types (PostgreSQL dialect). */

export const SECTION_CODES = [
  "TOK",
  "PAR",
  "TYP",
  "EXP",
  "FUN",
  "DAT",
  "JSN",
  "ARR",
  "AGG",
  "WIN",
  "SEL",
  "JOI",
  "CTE",
  "DDL",
  "DML",
  "CON",
  "SEQ",
  "TRG",
  "TXN",
  "GUC",
  "SCH",
  "CAT",
  "TSR",
  "CPY",
  "PRE",
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

/** IDs look like `TOK-01`, `WIN-frame-04`, `DET-seed-01`. */
export const SCENARIO_ID_RE = /^([A-Z]{3})(?:-[a-z0-9]+)*-\d{2,}$/;

export function catalogTestFile(code: SectionCode): string {
  return `tests/contract/catalog/${code.toLowerCase()}.test.ts`;
}

export type ScenarioRow = [
  suffix: string,
  title: string,
  kind?: ScenarioKind,
  notes?: string,
  extraEvidence?: string[],
  divergenceId?: string,
];

/** Build a catalog section from compact rows; IDs become `CODE-suffix`. */
export function section(code: SectionCode, title: string, promoted: boolean, items: ScenarioRow[]): CatalogSection {
  return {
    code,
    title,
    promoted,
    scenarios: items.map(([suffix, rowTitle, kind = "differential", notes, extra, divergenceId]) => {
      const id = `${code}-${suffix}`;
      if (!SCENARIO_ID_RE.test(id)) throw new Error(`bad scenario id: ${id}`);
      const scenario: Scenario = {
        id,
        title: rowTitle,
        kind,
        evidence: [catalogTestFile(code), ...(extra ?? [])],
      };
      if (notes !== undefined) scenario.notes = notes;
      if (divergenceId !== undefined) scenario.divergenceId = divergenceId;
      return scenario;
    }),
  };
}
