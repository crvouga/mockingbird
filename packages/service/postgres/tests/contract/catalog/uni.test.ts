import { UNI_SECTION } from "../../../compat/sections/uni.ts";
import { runCatalog } from "./run.ts";

runCatalog(UNI_SECTION, [
  {
    id: "UNI-utf-01",
    kind: "parity",
    setup: ["CREATE TABLE t (s text)", "INSERT INTO t VALUES ('héllo wörld'), ('日本語テキスト'), ('emoji 🎉 mix')"],
    sql: "SELECT s, length(s) AS n FROM t ORDER BY s",
  },
  {
    id: "UNI-len-01",
    kind: "parity",
    sql: "SELECT length('héllo') AS l1, char_length('日本語') AS l2, character_length('🎉') AS l3",
  },
  {
    id: "UNI-octet-01",
    kind: "parity",
    sql: "SELECT octet_length('a') AS a, octet_length('é') AS b, octet_length('日') AS c, octet_length('🎉') AS d",
  },
  {
    id: "UNI-astral-01",
    kind: "parity",
    sql: "SELECT length('a🎉b') AS len, substr('a🎉b', 2, 1) AS mid, position('b' IN 'a🎉b') AS pos",
  },
  {
    id: "UNI-nul-01",
    kind: "error",
    sql: "SELECT chr(0)",
    query: true,
    messageTier: "B",
    notes: "null-character wording differs across builds",
  },
  {
    id: "UNI-fold-01",
    kind: "parity",
    sql: "SELECT upper('mixedCase123') AS u, lower('MIXEDcase123') AS l, initcap('hello world') AS i",
  },
  {
    id: "UNI-char-01",
    kind: "parity",
    sql: "SELECT chr(65) AS a, ascii('A') AS code, chr(233) AS e_acute, ascii('é') AS e_code",
  },
  {
    id: "UNI-hex-01",
    kind: "parity",
    sql: "SELECT encode(convert_to('héllo', 'UTF8'), 'hex') AS hex",
  },
  {
    id: "UNI-esc-01",
    kind: "parity",
    sql: "SELECT e'tab\\there' AS t, e'newline\\nhere' AS n, e'\\u00e9' AS acc",
  },
]);
