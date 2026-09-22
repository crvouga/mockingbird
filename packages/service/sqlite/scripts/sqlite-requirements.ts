/**
 * Ingest SQLite.org requirements matrix into compat/requirements.json
 * and seed/update compat/coverage.json.
 *
 * Run: bun run scripts/sqlite-requirements.ts
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const COMPAT = join(ROOT, "compat");
const REQUIREMENTS_URL = "https://www.sqlite.org/requirements.html";

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

const NA_SOURCE_PREFIXES = [
  "c3ref/",
  "capi3ref.html",
  "vfs.html",
  "c_vfs.html",
  "fileformat2.html",
  "wal.html",
  "atomiccommit.html",
  "lockingv3.html",
  "uri.html",
  "psow.html",
  "malloc.html",
  "mutex.html",
  "pcache.html",
  "c_pcache.html",
  "backup.html",
  "c_backup",
  "sessionintro.html",
  "session/",
  "loadext.html",
  "c_load_extension",
  "c_config_",
  "c_dbconfig_",
  "c_limit_",
  "c_status",
  "c_trace",
  "c_progress",
  "c_interrupt",
  "c_soft_heap",
  "c_threadsafe",
  "c_initialize",
  "c_shutdown",
  "c_complete",
  "c_sql",
  "c_expanded_sql",
  "c_stmt_readonly",
  "c_stmt_busy",
  "c_stmt_isexplain",
  "c_stmt_explain",
  "c_stmt_scanstatus",
  "c_bind_",
  "c_blob",
  "c_column_",
  "c_result_",
  "c_value_",
  "c_create_function",
  "c_create_module",
  "c_create_collation",
  "c_create_window",
  "c_declare_vtab",
  "c_vtab_",
  "c_module",
  "c_index_info",
  "c_index_constraint",
  "c_autovacuum",
  "c_auto_extension",
  "c_cancel_auto",
  "c_commit_hook",
  "c_rollback_hook",
  "c_update_hook",
  "c_preupdate",
  "c_set_authorizer",
  "c_profile",
  "c_wal_hook",
  "c_wal_checkpoint",
  "c_wal_autocheckpoint",
  "c_db_cacheflush",
  "c_db_filename",
  "c_db_handle",
  "c_db_mutex",
  "c_db_name",
  "c_db_readonly",
  "c_db_release_memory",
  "c_db_status",
  "c_db_config",
  "c_errcode",
  "c_errmsg",
  "c_error_offset",
  "c_extended_errcode",
  "c_system_errno",
  "c_free",
  "c_malloc",
  "c_realloc",
  "c_memory_highwater",
  "c_memory_used",
  "c_soft_heap_limit",
  "c_hard_heap_limit",
  "c_release_memory",
  "c_str_",
  "c_snprintf",
  "c_mprintf",
  "c_vmprintf",
  "c_log",
  "c_randomness",
  "c_sleep",
  "c_uri_",
  "c_filename",
  "c_create_filename",
  "c_free_filename",
  "c_deserialize",
  "c_serialize",
  "c_get_autocommit",
  "c_get_clientdata",
  "c_set_clientdata",
  "c_get_auxdata",
  "c_set_auxdata",
  "c_get_table",
  "c_free_table",
  "c_interrupt",
  "c_is_interrupted",
  "c_keyword_",
  "c_last_insert_rowid",
  "c_libversion",
  "c_sourceid",
  "c_compileoption",
  "c_limit",
  "c_next_stmt",
  "c_open",
  "c_close",
  "c_prepare",
  "c_step",
  "c_finalize",
  "c_reset",
  "c_clear_bindings",
  "c_exec",
  "c_changes",
  "c_total_changes",
  "c_txn_state",
  "c_table_column_metadata",
  "c_test_control",
  "c_trace_v2",
  "c_unlock_notify",
  "c_user_data",
  "c_version",
  "c_vtab_collation",
  "c_vtab_config",
  "c_vtab_distinct",
  "c_vtab_in",
  "c_vtab_nochange",
  "c_vtab_on_conflict",
  "c_vtab_rhs_value",
  "c_win32_",
  "c_snapshot",
  "rescode.html",
  "c_abort.html",
  "c_static.html",
  "c_fcntl",
  "c_iocap",
  "c_lock",
  "c_sync",
  "c_access",
  "c_device",
  "c_shm",
  "c_file",
  "opcode.html",
  "opcode/",
  "vdbe.html",
  "arch.html",
  "howitworks.html",
  "malloc.html",
  "th3.html",
  "testing.html",
  "tclsqlite.html",
  "c_aggregate_context",
  "c_aggregate_count",
  "c_backup_finish",
  "c_backup_init",
  "c_backup_pagecount",
  "c_backup_remaining",
  "c_backup_step",
  "c_bind_blob",
  "c_bind_parameter",
  "c_blob_bytes",
  "c_blob_close",
  "c_blob_open",
  "c_blob_read",
  "c_blob_reopen",
  "c_blob_write",
  "c_busy",
  "c_changes64",
  "c_collation_needed",
  "c_column_blob",
  "c_column_bytes",
  "c_column_count",
  "c_column_database",
  "c_column_decltype",
  "c_column_name",
  "c_column_origin",
  "c_column_table",
  "c_column_text",
  "c_column_type",
  "c_column_value",
  "c_commit_hook.html",
  "c_complete.html",
  "c_config.html",
  "c_context_db_handle",
  "c_create_filename.html",
  "c_data_directory",
  "c_db_cacheflush.html",
  "c_db_config.html",
  "c_db_filename.html",
  "c_db_handle.html",
  "c_db_mutex.html",
  "c_db_name.html",
  "c_db_readonly.html",
  "c_db_release_memory.html",
  "c_db_status.html",
  "c_dbconfig_defensive",
  "c_declare_vtab.html",
  "c_deserialize.html",
  "c_drop_modules",
  "c_enable_load_extension",
  "c_enable_shared_cache",
  "c_errcode.html",
  "c_errmsg.html",
  "c_error_offset.html",
  "c_exec.html",
  "c_expanded_sql.html",
  "c_extended_errcode.html",
  "c_extended_result_codes",
  "c_file_control",
  "c_filename_database",
  "c_finalize.html",
  "c_get_autocommit.html",
  "c_get_auxdata.html",
  "c_get_clientdata.html",
  "c_get_table.html",
  "c_initialize.html",
  "c_interrupt.html",
  "c_keyword_check",
  "c_keyword_count",
  "c_keyword_name",
  "c_last_insert_rowid.html",
  "c_libversion.html",
  "c_libversion_number",
  "c_limit.html",
  "c_load_extension",
  "c_log.html",
  "c_malloc.html",
  "c_memory_highwater.html",
  "c_memory_used.html",
  "c_mprintf.html",
  "c_next_stmt.html",
  "c_normalized_sql",
  "c_open.html",
  "c_open_blob",
  "c_overload_function",
  "c_prepare.html",
  "c_preupdate_blobwrite",
  "c_preupdate_count",
  "c_preupdate_depth",
  "c_preupdate_hook",
  "c_preupdate_new",
  "c_preupdate_old",
  "c_profile.html",
  "c_progress_handler",
  "c_randomness.html",
  "c_realloc.html",
  "c_release_memory.html",
  "c_reset.html",
  "c_reset_auto_extension",
  "c_result_blob",
  "c_result_error",
  "c_result_int",
  "c_result_null",
  "c_result_subtype",
  "c_result_text",
  "c_result_value",
  "c_result_zeroblob",
  "c_rollback_hook.html",
  "c_serialize.html",
  "c_set_authorizer.html",
  "c_set_auxdata.html",
  "c_set_clientdata.html",
  "c_set_last_insert_rowid",
  "c_setlk_timeout",
  "c_shutdown.html",
  "c_sleep.html",
  "c_snapshot_cmp",
  "c_snapshot_free",
  "c_snapshot_get",
  "c_snapshot_open",
  "c_snapshot_recover",
  "c_soft_heap_limit64",
  "c_sourceid.html",
  "c_sql.html",
  "c_status.html",
  "c_step.html",
  "c_stmt_busy.html",
  "c_stmt_explain.html",
  "c_stmt_isexplain.html",
  "c_stmt_readonly.html",
  "c_stmt_scanstatus.html",
  "c_stmt_status",
  "c_strglob",
  "c_stricmp",
  "c_strlike",
  "c_strnicmp",
  "c_system_errno.html",
  "c_table_column_metadata.html",
  "c_test_control.html",
  "c_total_changes.html",
  "c_total_changes64",
  "c_trace.html",
  "c_trace_v2.html",
  "c_txn_state.html",
  "c_unlock_notify.html",
  "c_update_hook.html",
  "c_uri_boolean",
  "c_uri_int64",
  "c_uri_key",
  "c_uri_parameter",
  "c_user_data.html",
  "c_value_blob",
  "c_value_bytes",
  "c_value_dup",
  "c_value_free",
  "c_value_frombind",
  "c_value_nochange",
  "c_value_numeric",
  "c_value_pointer",
  "c_value_subtype",
  "c_value_text",
  "c_value_type",
  "c_version.html",
  "c_vfs_find",
  "c_vfs_register",
  "c_vtab_collation.html",
  "c_vtab_config.html",
  "c_vtab_distinct.html",
  "c_vtab_in.html",
  "c_vtab_nochange.html",
  "c_vtab_on_conflict.html",
  "c_vtab_rhs_value.html",
  "c_wal_autocheckpoint.html",
  "c_wal_checkpoint_v2",
  "c_wal_hook.html",
  "c_win32_set_directory",
];

/** Source-doc → default coverage seed (refined later by gate/tests). */
const SOURCE_SEED: Record<string, { status: CoverageStatus; evidence: string[]; notes: string }> = {
  "datatype3.html": {
    status: "VERIFIED",
    evidence: ["tests/contract/types/", "tests/contract/null/"],
    notes: "Affinity/storage-class contracts",
  },
  "lang_expr.html": {
    status: "PARTIALLY_VERIFIED",
    evidence: ["tests/contract/expressions/"],
    notes: "Operators covered; LIKE case_sensitive_like; row-value/precedence edges expanding",
  },
  "lang_select.html": {
    status: "VERIFIED",
    evidence: ["tests/contract/select/", "tests/contract/joins/", "tests/fuzz/"],
    notes: "",
  },
  "lang_insert.html": {
    status: "VERIFIED",
    evidence: ["tests/contract/insert/", "tests/contract/upsert/"],
    notes: "",
  },
  "lang_update.html": {
    status: "VERIFIED",
    evidence: ["tests/contract/update/", "tests/contract/update-from/"],
    notes: "",
  },
  "lang_delete.html": {
    status: "VERIFIED",
    evidence: ["tests/contract/delete/"],
    notes: "",
  },
  "lang_returning.html": {
    status: "VERIFIED",
    evidence: ["tests/contract/returning/"],
    notes: "",
  },
  "lang_replace.html": {
    status: "VERIFIED",
    evidence: ["tests/contract/insert/", "tests/contract/conflicts/"],
    notes: "",
  },
  "lang_conflict.html": {
    status: "VERIFIED",
    evidence: ["tests/contract/conflicts/", "tests/contract/upsert/"],
    notes: "",
  },
  "lang_createtable.html": {
    status: "VERIFIED",
    evidence: ["tests/contract/schema/", "tests/contract/constraints/"],
    notes: "",
  },
  "lang_altertable.html": {
    status: "VERIFIED",
    evidence: ["tests/contract/alter-table/"],
    notes: "",
  },
  "lang_createindex.html": {
    status: "VERIFIED",
    evidence: [
      "tests/contract/indexes/",
      "tests/contract/indexes/partial.test.ts",
      "tests/contract/indexes/expression.test.ts",
      "tests/contract/indexes/prefix.test.ts",
    ],
    notes: "",
  },
  "lang_dropindex.html": {
    status: "VERIFIED",
    evidence: ["tests/contract/indexes/"],
    notes: "",
  },
  "lang_droptable.html": {
    status: "VERIFIED",
    evidence: ["tests/contract/schema/"],
    notes: "",
  },
  "lang_createview.html": {
    status: "VERIFIED",
    evidence: ["tests/contract/views/"],
    notes: "",
  },
  "lang_dropview.html": {
    status: "VERIFIED",
    evidence: ["tests/contract/views/"],
    notes: "",
  },
  "lang_createtrigger.html": {
    status: "VERIFIED",
    evidence: ["tests/contract/triggers/"],
    notes: "",
  },
  "lang_droptrigger.html": {
    status: "VERIFIED",
    evidence: ["tests/contract/triggers/"],
    notes: "",
  },
  "lang_attach.html": {
    status: "VERIFIED",
    evidence: ["tests/contract/attach/", "tests/contract/attach/file.test.ts"],
    notes: "In-memory schemas; file ATTACH records the path but does not open on-disk bytes",
  },
  "lang_detach.html": {
    status: "VERIFIED",
    evidence: ["tests/contract/attach/"],
    notes: "",
  },
  "lang_transaction.html": {
    status: "VERIFIED",
    evidence: ["tests/contract/transactions/"],
    notes: "",
  },
  "lang_savepoint.html": {
    status: "VERIFIED",
    evidence: ["tests/contract/savepoints/", "tests/contract/transactions/"],
    notes: "",
  },
  "lang_corefunc.html": {
    status: "VERIFIED",
    evidence: ["tests/contract/functions/", "tests/contract/functions/scope3-builtins.test.ts"],
    notes: "Scope-3 oracle builtins",
  },
  "lang_datefunc.html": {
    status: "VERIFIED",
    evidence: [
      "tests/contract/date-time/",
      "tests/contract/functions/scope3-builtins.test.ts",
      "tests/contract/determinism/",
    ],
    notes: "unixepoch/timediff included",
  },
  "lang_aggfunc.html": {
    status: "VERIFIED",
    evidence: ["tests/contract/aggregates/", "tests/contract/functions/scope3-builtins.test.ts"],
    notes: "string_agg included",
  },
  "lang_analyze.html": {
    status: "VERIFIED",
    evidence: ["tests/contract/misc/analyze-vacuum.test.ts"],
    notes: "sqlite_stat1 populated",
  },
  "lang_vacuum.html": {
    status: "VERIFIED",
    evidence: ["tests/contract/misc/analyze-vacuum.test.ts"],
    notes: ":memory: no-op success",
  },
  "lang_reindex.html": {
    status: "VERIFIED",
    evidence: ["tests/contract/misc/analyze-vacuum.test.ts"],
    notes: "",
  },
  "lang_explain.html": {
    status: "PARTIALLY_VERIFIED",
    evidence: ["tests/contract/errors/explain.test.ts"],
    notes: "Column shapes stubbed; not plan-identical",
  },
  "lang_indexedby.html": {
    status: "PARTIALLY_VERIFIED",
    evidence: ["tests/contract/errors/unsupported.test.ts", "tests/contract/indexes/indexed-by.test.ts"],
    notes: "Accepted as no-ops; missing indexes do not error (documented)",
  },
  "lang_comment.html": {
    status: "VERIFIED",
    evidence: ["tests/contract/lexer/", "tests/contract/parser/"],
    notes: "",
  },
  "lang_keywords.html": {
    status: "VERIFIED",
    evidence: ["tests/contract/parser/"],
    notes: "",
  },
  "lang_naming.html": {
    status: "VERIFIED",
    evidence: ["tests/contract/schema/"],
    notes: "",
  },
  "lang_createvtab.html": {
    status: "PARTIALLY_VERIFIED",
    evidence: ["tests/contract/fts/"],
    notes: "FTS5 partial; other modules closing",
  },
  "foreignkeys.html": {
    status: "VERIFIED",
    evidence: [
      "tests/contract/foreign-keys/",
      "tests/contract/foreign-keys/deferred.test.ts",
      "tests/contract/foreign-keys/composite.test.ts",
      "tests/fuzz/constraints.test.ts",
    ],
    notes: "",
  },
  "withoutrowid.html": {
    status: "VERIFIED",
    evidence: ["tests/contract/without-rowid/"],
    notes: "",
  },
  "stricttables.html": {
    status: "VERIFIED",
    evidence: ["tests/contract/schema/strict.test.ts", "tests/fuzz/constraints.test.ts"],
    notes: "",
  },
  "gencol.html": {
    status: "VERIFIED",
    evidence: ["tests/contract/generated/"],
    notes: "",
  },
  "partialindex.html": {
    status: "VERIFIED",
    evidence: ["tests/contract/indexes/partial.test.ts"],
    notes: "",
  },
  "expridx.html": {
    status: "VERIFIED",
    evidence: ["tests/contract/indexes/expression.test.ts"],
    notes: "",
  },
  "windowfunctions.html": {
    status: "VERIFIED",
    evidence: [
      "tests/contract/window-functions/",
      "tests/contract/window-functions/exclude.test.ts",
      "tests/fuzz/windows.test.ts",
    ],
    notes: "",
  },
  "lang_with.html": {
    status: "VERIFIED",
    evidence: ["tests/contract/cte/", "tests/contract/recursive-cte/", "tests/contract/cte/thin-gaps.test.ts"],
    notes: "MATERIALIZED/NOT MATERIALIZED accepted; both execute as materialized",
  },
  "json1.html": {
    status: "VERIFIED",
    evidence: ["tests/contract/json/", "tests/fuzz/json.test.ts"],
    notes: "",
  },
  "fts5.html": {
    status: "PARTIALLY_VERIFIED",
    evidence: [
      "tests/contract/fts/",
      "tests/contract/fts/changes.test.ts",
      "tests/contract/modules/scope3-modules.test.ts",
      "compat/fts-oracle-surface.json",
    ],
    notes: "FTS5 rewrite in progress: basic MATCH exists; tokenizers/query language/ranking/content modes expanding",
  },
  "fts3.html": {
    status: "PARTIALLY_VERIFIED",
    evidence: [
      "tests/contract/fts/",
      "tests/contract/fts/changes.test.ts",
      "tests/contract/modules/scope3-modules.test.ts",
      "compat/fts-oracle-surface.json",
    ],
    notes: "FTS3/4 surface expanding toward oracle parity (matchinfo/offsets/snippet/query syntax)",
  },
  "rtree.html": {
    status: "VERIFIED",
    evidence: ["tests/contract/modules/scope3-modules.test.ts"],
    notes: "",
  },
  "pragma.html": {
    status: "VERIFIED",
    evidence: ["tests/contract/pragma/", "tests/contract/pragma/inventory-sets.test.ts"],
    notes:
      "Statement + pragma_* TVFs; storage getters match bun :memory: defaults; compile_options/function_list content is sqlite-mem's; case_sensitive_like implemented",
  },
  "autoinc.html": {
    status: "VERIFIED",
    evidence: ["tests/contract/primary-keys/", "tests/contract/rowid/"],
    notes: "",
  },
  "rowvalue.html": {
    status: "VERIFIED",
    evidence: ["tests/contract/row-values/basic.test.ts"],
    notes: "",
  },
  "eqp.html": {
    status: "PARTIALLY_VERIFIED",
    evidence: ["tests/contract/errors/explain.test.ts"],
    notes: "EXPLAIN QUERY PLAN stub shapes",
  },
  "nulls.html": {
    status: "VERIFIED",
    evidence: ["tests/contract/null/"],
    notes: "",
  },
  "datatype3.html#collation": {
    status: "VERIFIED",
    evidence: ["tests/contract/collate/"],
    notes: "",
  },
};

function isNotApplicable(source: string): boolean {
  const s = source.toLowerCase();
  if (s.startsWith("c3ref/")) return true;
  if (s.startsWith("c_")) return true;
  for (const prefix of NA_SOURCE_PREFIXES) {
    if (s === prefix.toLowerCase() || s.startsWith(prefix.toLowerCase())) return true;
  }
  // File-format / VFS / WAL docs
  if (
    /^(vfs|wal|fileformat|locking|atomiccommit|psow|malloc|mutex|pcache|arch|howitworks|opcode|vdbe|th3|testing|tclsqlite|rescode)\b/.test(
      s,
    )
  ) {
    return true;
  }
  return false;
}

function parseRequirementsHtml(html: string): Requirement[] {
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#94;/g, "^");

  // Prefer markdown-converted style from WebFetch or raw HTML list items.
  const requirements: Requirement[] = [];
  const seen = new Set<string>();

  // Pattern from markdown conversion: - R-...\n- text (source: foo.html, ...)
  const mdRe = /R-(\d{5}(?:-\d{5}){7})\s*\n+\s*[-*]?\s*(.+?)\s*\(source:\s*([^,\s)]+)/gis;
  let m: RegExpExecArray | null;
  while ((m = mdRe.exec(text)) !== null) {
    const id = `R-${m[1]}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const body = m[2]!
      .replace(/<[^>]+>/g, "")
      .replace(/\s+/g, " ")
      .trim();
    const source = m[3]!.trim();
    requirements.push({
      id,
      text: body,
      source,
      classification: isNotApplicable(source) ? "NOT_APPLICABLE" : "SQL_BEHAVIOR",
    });
  }

  // HTML pattern fallback: R-... followed by text and source:
  if (requirements.length < 100) {
    const _htmlRe = /R-(\d{5}(?:-\d{5}){7})[\s\S]*?(?:source:\s*|href="[^"]*")\s*([a-z0-9_./-]+\.html)/gi;
    // Broader: id then nearby source
    const blockRe =
      /(R-\d{5}(?:-\d{5}){7})[\s\S]{0,800}?source:\s*([a-z0-9_./-]+\.html)[^)]*\)?\s*([\s\S]*?)(?=R-\d{5}|$)/gi;
    while ((m = blockRe.exec(text)) !== null) {
      const id = m[1]!;
      if (seen.has(id)) continue;
      seen.add(id);
      const source = m[2]!.trim();
      let body = m[3]!
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim();
      // Often body precedes source in list format — try alternate extraction
      if (body.length < 10) body = `(see ${source})`;
      requirements.push({
        id,
        text: body.slice(0, 2000),
        source,
        classification: isNotApplicable(source) ? "NOT_APPLICABLE" : "SQL_BEHAVIOR",
      });
    }
  }

  return requirements;
}

function seedCoverage(requirements: Requirement[]): Record<string, CoverageEntry> {
  const coverage: Record<string, CoverageEntry> = {};
  for (const req of requirements) {
    if (req.classification === "NOT_APPLICABLE") {
      coverage[req.id] = {
        status: "NOT_APPLICABLE",
        evidence: [],
        notes: `C API / storage / non-SQL surface (${req.source})`,
      };
      continue;
    }

    const base = req.source.split("#")[0]!.toLowerCase();
    const seed = SOURCE_SEED[req.source] ?? SOURCE_SEED[base] ?? SOURCE_SEED[`${base}`];

    if (seed) {
      coverage[req.id] = {
        status: seed.status,
        evidence: [...seed.evidence],
        notes: seed.notes,
      };
    } else {
      // Default SQL_BEHAVIOR without a seed → PARTIALLY_VERIFIED if lang_*, else UNSUPPORTED until mapped
      const status: CoverageStatus =
        /^(lang_|datatype|json|fts|rtree|pragma|foreign|window|nulls|rowvalue|autoinc|without|strict|gen|partial|expridx|eqp)/.test(
          base,
        )
          ? "PARTIALLY_VERIFIED"
          : "UNSUPPORTED";
      coverage[req.id] = {
        status,
        evidence: [],
        notes:
          status === "UNSUPPORTED" ? `Unmapped SQL source: ${req.source}` : `Seeded from source bucket: ${req.source}`,
      };
    }
  }
  return coverage;
}

function mergeCoverage(
  existing: Record<string, CoverageEntry>,
  seeded: Record<string, CoverageEntry>,
): Record<string, CoverageEntry> {
  const out: Record<string, CoverageEntry> = { ...seeded };
  for (const [id, entry] of Object.entries(existing)) {
    if (!out[id]) {
      out[id] = entry;
      continue;
    }
    // Preserve manually upgraded statuses (VERIFIED wins over PARTIAL over UNSUPPORTED)
    const rank = (s: CoverageStatus) =>
      s === "VERIFIED" ? 3 : s === "PARTIALLY_VERIFIED" ? 2 : s === "UNSUPPORTED" ? 1 : 0;
    if (rank(entry.status) >= rank(out[id]!.status) && entry.evidence.length > 0) {
      out[id] = {
        status: entry.status,
        evidence: [...new Set([...entry.evidence, ...out[id]!.evidence])],
        notes: entry.notes || out[id]!.notes,
      };
    }
  }
  return out;
}

const MIN_REQUIREMENTS = 500;

async function loadHtml(forceNetwork = false): Promise<string> {
  const vendored = join(COMPAT, "requirements.raw.html");
  if (!forceNetwork && existsSync(vendored)) {
    return readFileSync(vendored, "utf8");
  }
  const res = await fetch(REQUIREMENTS_URL);
  if (!res.ok) throw new Error(`Failed to fetch ${REQUIREMENTS_URL}: ${res.status}`);
  const html = await res.text();
  mkdirSync(COMPAT, { recursive: true });
  writeFileSync(vendored, html);
  return html;
}

function loadCommittedRequirements(path: string): Requirement[] | null {
  if (!existsSync(path)) return null;
  try {
    const data = JSON.parse(readFileSync(path, "utf8")) as { requirements?: Requirement[] };
    const list = data.requirements;
    if (!Array.isArray(list) || list.length < MIN_REQUIREMENTS) return null;
    return list;
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  mkdirSync(COMPAT, { recursive: true });
  const requirementsPath = join(COMPAT, "requirements.json");

  let requirements = parseRequirementsHtml(await loadHtml());
  if (requirements.length < MIN_REQUIREMENTS) {
    // Live sqlite.org HTML shape drifts; retry a forced network fetch once.
    try {
      requirements = parseRequirementsHtml(await loadHtml(true));
    } catch (err) {
      console.error(`Live requirements fetch failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  if (requirements.length < MIN_REQUIREMENTS) {
    const committed = loadCommittedRequirements(requirementsPath);
    if (committed) {
      console.error(
        `Parsed ${requirements.length} requirements from HTML; falling back to existing compat/requirements.json (${committed.length})`,
      );
      requirements = committed;
    }
  }

  console.error(`Parsed ${requirements.length} requirements`);

  if (requirements.length < MIN_REQUIREMENTS) {
    console.error(
      `ERROR: expected at least ${MIN_REQUIREMENTS} SQLite.org requirements, got ${requirements.length}. ` +
        "Vendor a parseable dump as compat/requirements.raw.html, or keep a previously generated compat/requirements.json.",
    );
    process.exit(1);
  }

  // Reclassify committed fallback data when the source mapping gains a new non-SQL document.
  requirements = requirements.map((requirement) =>
    isNotApplicable(requirement.source) ? { ...requirement, classification: "NOT_APPLICABLE" } : requirement,
  );

  writeFileSync(
    requirementsPath,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        sourceUrl: REQUIREMENTS_URL,
        count: requirements.length,
        requirements,
      },
      null,
      2,
    ),
  );

  const seeded = seedCoverage(requirements);
  const coveragePath = join(COMPAT, "coverage.json");
  let existing: Record<string, CoverageEntry> = {};
  if (existsSync(coveragePath)) {
    existing = JSON.parse(readFileSync(coveragePath, "utf8")).coverage ?? {};
  }
  const coverage = mergeCoverage(existing, seeded);

  // Intentional FTS honesty downgrade: do not preserve stale VERIFIED from thin MATCH-only evidence.
  for (const req of requirements) {
    const base = req.source.split("#")[0]!.toLowerCase();
    if (base !== "fts5.html" && base !== "fts3.html") continue;
    const seed = SOURCE_SEED[base];
    if (!seed) continue;
    coverage[req.id] = {
      status: seed.status,
      evidence: [...seed.evidence],
      notes: seed.notes,
    };
  }

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
    coveragePath,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        referenceSqliteVersion: "3.51.0",
        counts,
        coverage,
      },
      null,
      2,
    ),
  );

  console.log(
    JSON.stringify(
      {
        requirementsPath,
        coveragePath,
        counts,
      },
      null,
      2,
    ),
  );

  if (counts.unknown > 0) {
    console.error(`ERROR: ${counts.unknown} SQL_BEHAVIOR requirements still unknown`);
    process.exitCode = 1;
  }
}

if (import.meta.main) {
  await main();
}
