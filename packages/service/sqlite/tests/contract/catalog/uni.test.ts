import { runCatalog } from "./run.ts";

runCatalog("UNI", [
  { id: "UNI-utf-01", kind: "parity", sql: "SELECT 'héllo 世界 🌍' AS v" },
  { id: "UNI-len-01", kind: "parity", sql: "SELECT length('héllo 世界 🌍')" },
  { id: "UNI-astral-01", kind: "parity", sql: "SELECT length('🌍'), substr('a🌍b', 2, 1), instr('a🌍b', '🌍')" },
  {
    id: "UNI-surr-01",
    kind: "parity",
    sql: "SELECT length(?)",
    params: ["\uD800"],
  },
  { id: "UNI-nul-01", kind: "parity", sql: "SELECT 'ab' AS v" },
  { id: "UNI-fold-01", kind: "parity", sql: "SELECT upper('ä'), lower('Ä'), 'Ä' LIKE 'ä'" },
  { id: "UNI-char-01", kind: "parity", sql: "SELECT unicode(char(233)), char(unicode('é'))" },
  { id: "UNI-hex-01", kind: "parity", sql: "SELECT hex(CAST('é' AS BLOB))" },
]);
