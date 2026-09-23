/**
 * Construct-level drop-in parity catalog. Every scenario ID here must execute
 * in `tests/contract/catalog/<code>.test.ts` — the gate enforces the mapping.
 */
import { type CatalogSection, SCENARIO_ID_RE, type Scenario } from "./scenario-types.ts";
import { AGG_SECTION } from "./sections/agg.ts";
import { API_SECTION } from "./sections/api.ts";
import { ARR_SECTION } from "./sections/arr.ts";
import { CAT_SECTION } from "./sections/cat.ts";
import { CON_SECTION } from "./sections/con.ts";
import { CPY_SECTION } from "./sections/cpy.ts";
import { CTE_SECTION } from "./sections/cte.ts";
import { DAT_SECTION } from "./sections/dat.ts";
import { DDL_SECTION } from "./sections/ddl.ts";
import { DET_SECTION } from "./sections/det.ts";
import { DML_SECTION } from "./sections/dml.ts";
import { ECO_SECTION } from "./sections/eco.ts";
import { ERR_SECTION } from "./sections/err.ts";
import { EXP_SECTION } from "./sections/exp.ts";
import { FUN_SECTION } from "./sections/fun.ts";
import { FZZ_SECTION } from "./sections/fzz.ts";
import { GUC_SECTION } from "./sections/guc.ts";
import { JOI_SECTION } from "./sections/joi.ts";
import { JSN_SECTION } from "./sections/jsn.ts";
import { LIM_SECTION } from "./sections/lim.ts";
import { PAR_SECTION } from "./sections/par.ts";
import { PRE_SECTION } from "./sections/pre.ts";
import { SCH_SECTION } from "./sections/sch.ts";
import { SEL_SECTION } from "./sections/sel.ts";
import { SEQ_SECTION } from "./sections/seq.ts";
import { SNP_SECTION } from "./sections/snp.ts";
import { TOK_SECTION } from "./sections/tok.ts";
import { TRG_SECTION } from "./sections/trg.ts";
import { TSR_SECTION } from "./sections/tsr.ts";
import { TXN_SECTION } from "./sections/txn.ts";
import { TYP_SECTION } from "./sections/typ.ts";
import { UNI_SECTION } from "./sections/uni.ts";
import { WIN_SECTION } from "./sections/win.ts";

export const SCENARIO_CATALOG: CatalogSection[] = [
  TOK_SECTION,
  PAR_SECTION,
  TYP_SECTION,
  EXP_SECTION,
  FUN_SECTION,
  DAT_SECTION,
  JSN_SECTION,
  ARR_SECTION,
  AGG_SECTION,
  WIN_SECTION,
  SEL_SECTION,
  JOI_SECTION,
  CTE_SECTION,
  DDL_SECTION,
  DML_SECTION,
  CON_SECTION,
  SEQ_SECTION,
  TRG_SECTION,
  TXN_SECTION,
  GUC_SECTION,
  SCH_SECTION,
  CAT_SECTION,
  TSR_SECTION,
  CPY_SECTION,
  PRE_SECTION,
  API_SECTION,
  SNP_SECTION,
  DET_SECTION,
  ERR_SECTION,
  UNI_SECTION,
  LIM_SECTION,
  FZZ_SECTION,
  ECO_SECTION,
];

export function allScenarios(): Scenario[] {
  return SCENARIO_CATALOG.flatMap((section) => section.scenarios);
}

export function scenarioById(): Map<string, Scenario> {
  return new Map(allScenarios().map((scenario) => [scenario.id, scenario]));
}

export function knownScenarioIds(): Set<string> {
  return new Set(allScenarios().map((scenario) => scenario.id));
}

const seen = new Set<string>();
for (const section of SCENARIO_CATALOG) {
  for (const scenario of section.scenarios) {
    if (!SCENARIO_ID_RE.test(scenario.id)) throw new Error(`bad scenario id: ${scenario.id}`);
    if (!scenario.id.startsWith(`${section.code}-`)) {
      throw new Error(`scenario ${scenario.id} does not belong to section ${section.code}`);
    }
    if (seen.has(scenario.id)) throw new Error(`duplicate scenario id: ${scenario.id}`);
    seen.add(scenario.id);
  }
}
