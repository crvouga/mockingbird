/**
 * Ingest the PostgreSQL 18 SQL-commands doc index into compat/requirements.json
 * and seed/update compat/coverage.json.
 *
 * Run: bun run scripts/postgres-requirements.ts
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const COMPAT = join(ROOT, "compat");
const COMMANDS_URL = "https://www.postgresql.org/docs/18/sql-commands.html";

export type RequirementClass = "NOT_APPLICABLE" | "SQL_BEHAVIOR";
export type CoverageStatus = "VERIFIED" | "PARTIALLY_VERIFIED" | "UNSUPPORTED" | "NOT_APPLICABLE";

export interface Requirement {
  id: string;
  text: string;
  source: string;
  classification: RequirementClass;
}

export interface CoverageEntry {
  status: CoverageStatus;
  evidence: string[];
  notes: string;
}

/**
 * Commands outside the SQL dialect surface of an in-memory, single-session
 * engine: roles/privileges, replication, physical storage, server admin,
 * cross-session messaging, protocol cursors, two-phase commit.
 */
const NA_SLUGS = new Set([
  // roles and privileges
  "sql-alterdefaultprivileges",
  "sql-altergroup",
  "sql-alterpolicy",
  "sql-alterrole",
  "sql-alteruser",
  "sql-alterusermapping",
  "sql-creategroup",
  "sql-createpolicy",
  "sql-createrole",
  "sql-createuser",
  "sql-createusermapping",
  "sql-drop-owned",
  "sql-dropgroup",
  "sql-droppolicy",
  "sql-droprole",
  "sql-dropuser",
  "sql-dropusermapping",
  "sql-reassign-owned",
  "sql-set-role",
  "sql-set-session-authorization",
  // databases, tablespaces, server infrastructure
  "sql-alterdatabase",
  "sql-createdatabase",
  "sql-dropdatabase",
  "sql-altersystem",
  "sql-altertablespace",
  "sql-createtablespace",
  "sql-droptablespace",
  // replication and logical decoding
  "sql-alterpublication",
  "sql-altersubscription",
  "sql-createpublication",
  "sql-createsubscription",
  "sql-droppublication",
  "sql-dropsubscription",
  // foreign data
  "sql-alterforeigndatawrapper",
  "sql-alterforeigntable",
  "sql-alterserver",
  "sql-createforeigndatawrapper",
  "sql-createforeigntable",
  "sql-createserver",
  "sql-dropforeigndatawrapper",
  "sql-dropforeigntable",
  "sql-dropserver",
  "sql-importforeignschema",
  // extensions and languages
  "sql-alterextension",
  "sql-createextension",
  "sql-dropextension",
  "sql-alterlanguage",
  "sql-createlanguage",
  "sql-droplanguage",
  // two-phase commit
  "sql-commit-prepared",
  "sql-prepare-transaction",
  "sql-rollback-prepared",
  // event triggers
  "sql-altereventtrigger",
  "sql-createeventtrigger",
  "sql-dropeventtrigger",
  // server-side load
  "sql-load",
]);

/** slug → coverage seed. Everything else defaults to UNSUPPORTED (fails loud). */
const SEED: Record<string, { status: CoverageStatus; evidence: string[]; notes: string }> = {
  "sql-select": {
    status: "VERIFIED",
    evidence: ["tests/contract/select/", "tests/contract/joins/", "tests/contract/grouping/", "tests/fuzz/"],
    notes: "",
  },
  "sql-insert": {
    status: "VERIFIED",
    evidence: ["tests/contract/insert/", "tests/contract/on-conflict/", "tests/contract/returning/"],
    notes: "",
  },
  "sql-update": {
    status: "VERIFIED",
    evidence: ["tests/contract/update/", "tests/contract/update-from/"],
    notes: "",
  },
  "sql-delete": { status: "VERIFIED", evidence: ["tests/contract/delete/"], notes: "" },
  "sql-truncate": { status: "VERIFIED", evidence: ["tests/contract/delete/"], notes: "" },
  "sql-values": { status: "VERIFIED", evidence: ["tests/contract/select/", "tests/contract/unions/"], notes: "" },
  "sql-copy": {
    status: "PARTIALLY_VERIFIED",
    evidence: ["tests/contract/copy/"],
    notes: "text and csv formats via API hook; binary format unsupported",
  },
  // transactions
  "sql-begin": { status: "VERIFIED", evidence: ["tests/contract/transactions/"], notes: "" },
  "sql-commit": { status: "VERIFIED", evidence: ["tests/contract/transactions/"], notes: "" },
  "sql-rollback": { status: "VERIFIED", evidence: ["tests/contract/transactions/"], notes: "" },
  "sql-abort": { status: "VERIFIED", evidence: ["tests/contract/transactions/"], notes: "" },
  "sql-end": { status: "VERIFIED", evidence: ["tests/contract/transactions/"], notes: "" },
  "sql-start-transaction": {
    status: "PARTIALLY_VERIFIED",
    evidence: ["tests/contract/transactions/"],
    notes: "isolation-level clauses parsed; single-session engine has no concurrent isolation",
  },
  "sql-savepoint": { status: "VERIFIED", evidence: ["tests/contract/savepoints/"], notes: "" },
  "sql-release-savepoint": { status: "VERIFIED", evidence: ["tests/contract/savepoints/"], notes: "" },
  "sql-rollback-to": { status: "VERIFIED", evidence: ["tests/contract/savepoints/"], notes: "" },
  "sql-set-transaction": {
    status: "PARTIALLY_VERIFIED",
    evidence: ["tests/contract/transactions/"],
    notes: "parsed; isolation levels are meaningless in a single-session engine",
  },
  "sql-set-constraints": {
    status: "PARTIALLY_VERIFIED",
    evidence: ["tests/contract/foreign-keys/"],
    notes: "DEFERRABLE parsed; constraints check at statement end",
  },
  "sql-lock": {
    status: "PARTIALLY_VERIFIED",
    evidence: ["tests/contract/transactions/"],
    notes: "parsed no-op; no concurrent lockers exist",
  },
  // DDL
  "sql-createtable": {
    status: "VERIFIED",
    evidence: ["tests/contract/constraints/", "tests/contract/defaults/", "tests/contract/generated/"],
    notes: "",
  },
  "sql-createtableas": { status: "VERIFIED", evidence: ["tests/contract/create-table-as/"], notes: "" },
  "sql-selectinto": {
    status: "UNSUPPORTED",
    evidence: [],
    notes: "use CREATE TABLE AS; SELECT INTO fails loud",
  },
  "sql-altertable": { status: "VERIFIED", evidence: ["tests/contract/alter-table/"], notes: "" },
  "sql-droptable": {
    status: "VERIFIED",
    evidence: ["tests/contract/alter-table/", "tests/contract/catalog/"],
    notes: "",
  },
  "sql-createindex": { status: "VERIFIED", evidence: ["tests/contract/indexes/"], notes: "" },
  "sql-alterindex": { status: "VERIFIED", evidence: ["tests/contract/indexes/"], notes: "" },
  "sql-dropindex": { status: "VERIFIED", evidence: ["tests/contract/indexes/"], notes: "" },
  "sql-createview": { status: "VERIFIED", evidence: ["tests/contract/views/"], notes: "" },
  "sql-alterview": { status: "VERIFIED", evidence: ["tests/contract/views/"], notes: "" },
  "sql-dropview": { status: "VERIFIED", evidence: ["tests/contract/views/"], notes: "" },
  "sql-creatematerializedview": {
    status: "PARTIALLY_VERIFIED",
    evidence: ["tests/contract/views/"],
    notes: "materialized views are eager snapshots refreshed by REFRESH MATERIALIZED VIEW",
  },
  "sql-altermaterializedview": {
    status: "PARTIALLY_VERIFIED",
    evidence: ["tests/contract/views/"],
    notes: "rename supported",
  },
  "sql-dropmaterializedview": { status: "VERIFIED", evidence: ["tests/contract/views/"], notes: "" },
  "sql-refreshmaterializedview": { status: "VERIFIED", evidence: ["tests/contract/views/"], notes: "" },
  "sql-createsequence": { status: "VERIFIED", evidence: ["tests/contract/sequences/"], notes: "" },
  "sql-altersequence": { status: "VERIFIED", evidence: ["tests/contract/sequences/"], notes: "" },
  "sql-dropsequence": { status: "VERIFIED", evidence: ["tests/contract/sequences/"], notes: "" },
  "sql-createschema": {
    status: "VERIFIED",
    evidence: ["tests/contract/schemas/", "tests/contract/search-path/"],
    notes: "",
  },
  "sql-alterschema": { status: "VERIFIED", evidence: ["tests/contract/schemas/"], notes: "" },
  "sql-dropschema": { status: "VERIFIED", evidence: ["tests/contract/schemas/"], notes: "" },
  "sql-createtype": {
    status: "PARTIALLY_VERIFIED",
    evidence: ["tests/contract/types/", "tests/contract/catalog/"],
    notes: "enum types supported; composite/range/base types fail loud",
  },
  "sql-altertype": {
    status: "PARTIALLY_VERIFIED",
    evidence: ["tests/contract/types/"],
    notes: "ADD VALUE / RENAME supported for enums",
  },
  "sql-droptype": { status: "VERIFIED", evidence: ["tests/contract/types/"], notes: "" },
  "sql-createdomain": { status: "VERIFIED", evidence: ["tests/contract/types/", "tests/contract/catalog/"], notes: "" },
  "sql-alterdomain": {
    status: "PARTIALLY_VERIFIED",
    evidence: ["tests/contract/types/"],
    notes: "constraint add/drop supported",
  },
  "sql-dropdomain": { status: "VERIFIED", evidence: ["tests/contract/types/"], notes: "" },
  "sql-createfunction": {
    status: "PARTIALLY_VERIFIED",
    evidence: ["tests/contract/functions/"],
    notes:
      "LANGUAGE sql plus plpgsql-lite (DECLARE, EXCEPTION WHEN others, CASE, FOR-IN-SELECT, RETURN NEXT); no cursors/NOTICE/packages",
  },
  "sql-alterfunction": {
    status: "PARTIALLY_VERIFIED",
    evidence: ["tests/contract/functions/"],
    notes: "parsed no-op",
  },
  "sql-dropfunction": { status: "VERIFIED", evidence: ["tests/contract/functions/"], notes: "" },
  "sql-createtrigger": {
    status: "PARTIALLY_VERIFIED",
    evidence: ["tests/contract/triggers/"],
    notes: "row-level BEFORE/AFTER with LANGUAGE sql-expressible bodies; INSTEAD OF fails loud",
  },
  "sql-altertrigger": {
    status: "PARTIALLY_VERIFIED",
    evidence: ["tests/contract/triggers/"],
    notes: "rename supported",
  },
  "sql-droptrigger": { status: "VERIFIED", evidence: ["tests/contract/triggers/"], notes: "" },
  "sql-comment": {
    status: "PARTIALLY_VERIFIED",
    evidence: ["tests/contract/catalog/"],
    notes: "parsed and accepted; comments are not stored (divergence comment-on-not-stored)",
  },
  // session settings and prepared statements
  "sql-set": { status: "VERIFIED", evidence: ["tests/contract/set-show/"], notes: "" },
  "sql-show": { status: "VERIFIED", evidence: ["tests/contract/set-show/"], notes: "" },
  "sql-reset": { status: "VERIFIED", evidence: ["tests/contract/set-show/"], notes: "" },
  "sql-prepare": { status: "VERIFIED", evidence: ["tests/contract/prepare-execute/"], notes: "" },
  "sql-execute": { status: "VERIFIED", evidence: ["tests/contract/prepare-execute/"], notes: "" },
  "sql-deallocate": { status: "VERIFIED", evidence: ["tests/contract/prepare-execute/"], notes: "" },
  "sql-discard": {
    status: "PARTIALLY_VERIFIED",
    evidence: ["tests/contract/set-show/"],
    notes: "parsed no-op",
  },
  // utility
  "sql-explain": {
    status: "PARTIALLY_VERIFIED",
    evidence: ["tests/contract/errors/"],
    notes: "stub plan shapes; not plan-identical",
  },
  "sql-do": {
    status: "PARTIALLY_VERIFIED",
    evidence: ["tests/contract/functions/"],
    notes: "LANGUAGE sql bodies only",
  },
  "sql-vacuum": {
    status: "PARTIALLY_VERIFIED",
    evidence: ["tests/contract/misc/"],
    notes: "parsed no-op; there is no physical storage to vacuum",
  },
  "sql-analyze": {
    status: "PARTIALLY_VERIFIED",
    evidence: ["tests/contract/misc/"],
    notes: "parsed no-op; no planner statistics",
  },
  "sql-checkpoint": { status: "PARTIALLY_VERIFIED", evidence: ["tests/contract/misc/"], notes: "parsed no-op" },
  "sql-cluster": { status: "PARTIALLY_VERIFIED", evidence: ["tests/contract/misc/"], notes: "parsed no-op" },
  "sql-reindex": { status: "PARTIALLY_VERIFIED", evidence: ["tests/contract/misc/"], notes: "parsed no-op" },
  "sql-grant": { status: "PARTIALLY_VERIFIED", evidence: ["tests/contract/misc/"], notes: "parsed no-op (no roles)" },
  "sql-revoke": { status: "PARTIALLY_VERIFIED", evidence: ["tests/contract/misc/"], notes: "parsed no-op (no roles)" },
  "sql-security-label": { status: "PARTIALLY_VERIFIED", evidence: ["tests/contract/misc/"], notes: "parsed no-op" },
  // explicitly unsupported dialect statements (fail loud)
  "sql-merge": { status: "UNSUPPORTED", evidence: [], notes: "MERGE fails loud; use INSERT ... ON CONFLICT" },
  "sql-call": { status: "UNSUPPORTED", evidence: [], notes: "procedures are unsupported; CALL fails loud" },
  "sql-createprocedure": { status: "UNSUPPORTED", evidence: [], notes: "procedures fail loud" },
  "sql-alterprocedure": { status: "UNSUPPORTED", evidence: [], notes: "procedures fail loud" },
  "sql-dropprocedure": { status: "UNSUPPORTED", evidence: [], notes: "procedures fail loud" },
  "sql-listen": { status: "UNSUPPORTED", evidence: [], notes: "LISTEN/NOTIFY fails loud (single session)" },
  "sql-notify": { status: "UNSUPPORTED", evidence: [], notes: "LISTEN/NOTIFY fails loud (single session)" },
  "sql-unlisten": { status: "UNSUPPORTED", evidence: [], notes: "LISTEN/NOTIFY fails loud (single session)" },
  "sql-declare": { status: "UNSUPPORTED", evidence: [], notes: "protocol cursors fail loud" },
  "sql-fetch": { status: "UNSUPPORTED", evidence: [], notes: "protocol cursors fail loud" },
  "sql-move": { status: "UNSUPPORTED", evidence: [], notes: "protocol cursors fail loud" },
  "sql-close": { status: "UNSUPPORTED", evidence: [], notes: "protocol cursors fail loud" },
};

function classify(slug: string): RequirementClass {
  return NA_SLUGS.has(slug) ? "NOT_APPLICABLE" : "SQL_BEHAVIOR";
}

export function parseCommandsHtml(html: string): Requirement[] {
  const re = /<a href="(sql-[a-z0-9-]+)\.html">([^<]+)<\/a><\/span>\s*<span class="refpurpose">\s*—\s*([^<]+)<\/span>/g;
  const out: Requirement[] = [];
  const seen = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const slug = m[1]!;
    if (seen.has(slug)) continue;
    seen.add(slug);
    const title = m[2]!.replace(/\s+/g, " ").trim();
    const purpose = m[3]!.replace(/\s+/g, " ").trim();
    out.push({
      id: slug,
      text: `${title} — ${purpose}`,
      source: `${slug}.html`,
      classification: classify(slug),
    });
  }
  return out;
}

function seedCoverage(requirements: Requirement[]): Record<string, CoverageEntry> {
  const coverage: Record<string, CoverageEntry> = {};
  for (const req of requirements) {
    if (req.classification === "NOT_APPLICABLE") {
      coverage[req.id] = {
        status: "NOT_APPLICABLE",
        evidence: [],
        notes: "roles/replication/storage/server-admin surface; out of scope for an in-memory single-session engine",
      };
      continue;
    }
    const seed = SEED[req.id];
    if (seed) {
      coverage[req.id] = { status: seed.status, evidence: [...seed.evidence], notes: seed.notes };
    } else {
      coverage[req.id] = {
        status: "UNSUPPORTED",
        evidence: [],
        notes: "not implemented; statements fail loud via unsupported()",
      };
    }
  }
  return coverage;
}

const MIN_REQUIREMENTS = 150;

async function loadHtml(forceNetwork = false): Promise<string> {
  const vendored = join(COMPAT, "requirements.raw.html");
  if (!forceNetwork && existsSync(vendored)) return readFileSync(vendored, "utf8");
  const res = await fetch(COMMANDS_URL);
  if (!res.ok) throw new Error(`Failed to fetch ${COMMANDS_URL}: ${res.status}`);
  const html = await res.text();
  mkdirSync(COMPAT, { recursive: true });
  writeFileSync(vendored, html);
  return html;
}

async function main(): Promise<void> {
  mkdirSync(COMPAT, { recursive: true });
  let requirements = parseCommandsHtml(await loadHtml());
  if (requirements.length < MIN_REQUIREMENTS) {
    try {
      requirements = parseCommandsHtml(await loadHtml(true));
    } catch (err) {
      console.error(`Live commands fetch failed: ${err instanceof Error ? err.message : err}`);
    }
  }
  console.error(`Parsed ${requirements.length} SQL commands`);
  if (requirements.length < MIN_REQUIREMENTS) {
    console.error(
      `ERROR: expected at least ${MIN_REQUIREMENTS} SQL commands, got ${requirements.length}. ` +
        "Vendor a parseable dump as compat/requirements.raw.html.",
    );
    process.exit(1);
  }

  // Every SEED entry must reference an existing command and existing evidence.
  const known = new Set(requirements.map((r) => r.id));
  for (const slug of Object.keys(SEED)) {
    if (!known.has(slug)) {
      console.error(`ERROR: SEED references unknown command ${slug}`);
      process.exitCode = 1;
    }
  }
  for (const [slug, seed] of Object.entries(SEED)) {
    for (const rel of seed.evidence) {
      if (!existsSync(join(ROOT, rel))) {
        console.error(`ERROR: SEED ${slug} evidence missing: ${rel}`);
        process.exitCode = 1;
      }
    }
  }
  for (const slug of NA_SLUGS) {
    if (!known.has(slug)) {
      console.error(`ERROR: NA_SLUGS references unknown command ${slug}`);
      process.exitCode = 1;
    }
  }

  writeFileSync(
    join(COMPAT, "requirements.json"),
    JSON.stringify(
      { generatedAt: new Date().toISOString(), sourceUrl: COMMANDS_URL, count: requirements.length, requirements },
      null,
      2,
    ),
  );

  const coverage = seedCoverage(requirements);
  const sqlBehavior = requirements.filter((r) => r.classification === "SQL_BEHAVIOR");
  const counts = {
    total: requirements.length,
    notApplicable: requirements.length - sqlBehavior.length,
    sqlBehavior: sqlBehavior.length,
    verified: 0,
    partiallyVerified: 0,
    unsupported: 0,
    unknown: 0,
  };
  for (const req of sqlBehavior) {
    const st = coverage[req.id]?.status;
    if (st === "VERIFIED") counts.verified++;
    else if (st === "PARTIALLY_VERIFIED") counts.partiallyVerified++;
    else if (st === "UNSUPPORTED") counts.unsupported++;
    else counts.unknown++;
  }

  writeFileSync(
    join(COMPAT, "coverage.json"),
    JSON.stringify(
      { generatedAt: new Date().toISOString(), referenceServerVersion: "18.3", counts, coverage },
      null,
      2,
    ),
  );

  console.log(JSON.stringify({ counts }, null, 2));
  if (counts.unknown > 0) {
    console.error(`ERROR: ${counts.unknown} SQL_BEHAVIOR requirements still unknown`);
    process.exitCode = 1;
  }
}

if (import.meta.main) await main();
