import { type CatalogSection, section } from "../scenario-types.ts";

const D = "documented_divergence" as const;
const DIV = "sync-api-surface";

export const API_SECTION: CatalogSection = section("API", "JavaScript surface contracts", true, [
  ["exec-01", "exec runs multiple statements", D, "JS API surface, no oracle analog", undefined, DIV],
  ["exec-02", "exec rejects bind parameters", D, "JS API surface, no oracle analog", undefined, DIV],
  ["query-01", "query and prepare are single-statement", D, "JS API surface, no oracle analog", undefined, DIV],
  ["query-02", "query positional $n binds"],
  ["prep-01", "prepare-time syntax errors", D, "JS API surface, no oracle analog", undefined, DIV],
  ["prep-02", "prepared statement reuse"],
  ["prep-03", "re-executed statement sees ALTER TABLE", undefined, undefined, ["tests/contract/api/"]],
  ["run-01", "run/all/get/result shapes", D, "JS API surface, no oracle analog", undefined, DIV],
  ["run-02", "get returns undefined for zero rows", D, "JS API surface, no oracle analog", undefined, DIV],
  ["run-03", "result keeps column metadata for zero rows", D, "JS API surface, no oracle analog", undefined, DIV],
  ["run-04", "all on INSERT RETURNING"],
  ["bind-01", "accepted bind types"],
  ["bind-02", "rejected bind types throw misuse", D, "JS API surface, no oracle analog", undefined, DIV],
  ["bind-03", "bigint binds enforce int8 range", D, "JS API surface, no oracle analog", undefined, DIV],
  ["ret-01", "int8 results surface as JS bigint", D, "JS API surface, no oracle analog", undefined, DIV],
  ["ret-02", "numeric/date/jsonb surface as canonical text", D, "JS API surface, no oracle analog", undefined, DIV],
  ["close-01", "close is idempotent; use after close is misuse", D, "JS API surface, no oracle analog", undefined, DIV],
  ["txn-01", "transaction(fn) commits and rolls back", D, "JS API surface, no oracle analog", undefined, DIV],
  ["txn-02", "nested transaction(fn) uses savepoints", D, "JS API surface, no oracle analog", undefined, DIV],
  ["sync-01", "methods return values, not Promises", D, "JS API surface, no oracle analog", undefined, DIV],
  ["copy-01", "copyFrom API loads COPY FROM STDIN data", D, "API-level COPY hook", ["tests/contract/copy/"], DIV],
  ["int8-01", "int8 mode number surfaces IEEE number", D, "JS API overlay, no oracle analog", undefined, DIV],
  ["int8-02", "int8 mode string surfaces decimal text", D, "JS API overlay, no oracle analog", undefined, DIV],
  ["fn-01", "registerFunction installs a JS scalar", D, "JS API overlay, not in PGMM", undefined, DIV],
  ["dump-01", "exec loads dump no-ops", D, "dump-compat overlay", undefined, "dump-compat-noop"],
  ["do-01", "DO blocks are no-ops", D, "PL/pgSQL is NOT APPLICABLE", undefined, "dump-compat-noop"],
  ["set-01", "ALTER TABLE SET storage parameters are no-ops", D, "storage params are NOT APPLICABLE", undefined, "dump-compat-noop"],
]);
