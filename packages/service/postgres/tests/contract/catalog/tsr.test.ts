import { TSR_SECTION } from "../../../compat/sections/tsr.ts";
import { runCatalog } from "./run.ts";

const RANK = { realEpsilon: 1e-6 };

runCatalog(TSR_SECTION, [
  { id: "TSR-vec-01", kind: "parity", sql: "SELECT to_tsvector('english', 'The quick brown foxes jumped') AS v" },
  { id: "TSR-vec-02", kind: "parity", sql: "SELECT to_tsvector('The quick brown fox') AS v" },
  { id: "TSR-vec-03", kind: "parity", sql: "SELECT to_tsvector('simple', 'The Quick Brown') AS v" },
  { id: "TSR-vec-04", kind: "parity", sql: "SELECT to_tsvector('english', 'cat dog cat bird cat') AS v" },
  { id: "TSR-vec-05", kind: "parity", sql: "SELECT to_tsvector('english', '') AS v" },
  { id: "TSR-qry-01", kind: "parity", sql: "SELECT to_tsquery('english', 'quick & brown') AS v" },
  { id: "TSR-qry-02", kind: "parity", sql: "SELECT to_tsquery('english', 'quick | !brown') AS v" },
  { id: "TSR-qry-03", kind: "parity", sql: "SELECT to_tsquery('english', 'jumping') AS v" },
  { id: "TSR-qry-04", kind: "parity", sql: "SELECT plainto_tsquery('english', 'quick brown foxes') AS v" },
  { id: "TSR-qry-05", kind: "parity", sql: "SELECT phraseto_tsquery('english', 'quick brown fox') AS v" },
  { id: "TSR-lit-01", kind: "parity", sql: "SELECT 'cat dog'::tsvector AS v" },
  { id: "TSR-lit-02", kind: "parity", sql: "SELECT 'cat:1 dog:2'::tsvector AS v" },
  { id: "TSR-lit-03", kind: "parity", sql: "SELECT 'cat & dog'::tsquery AS v" },
  {
    id: "TSR-match-01",
    kind: "parity",
    sql: "SELECT to_tsvector('english', 'quick brown foxes') @@ to_tsquery('english', 'fox') AS v",
  },
  {
    id: "TSR-match-02",
    kind: "parity",
    sql: "SELECT to_tsvector('english', 'quick brown fox') @@ to_tsquery('english', 'cat') AS v",
  },
  {
    id: "TSR-match-03",
    kind: "parity",
    sql: "SELECT to_tsvector('english', 'quick brown') @@ to_tsquery('english', 'quick & brown') AS both, to_tsvector('english', 'quick') @@ to_tsquery('english', 'quick & brown') AS missing",
  },
  {
    id: "TSR-match-04",
    kind: "parity",
    sql: "SELECT to_tsvector('english', 'quick') @@ to_tsquery('english', 'quick | brown') AS v",
  },
  {
    id: "TSR-match-05",
    kind: "parity",
    sql: "SELECT to_tsvector('english', 'cat') @@ to_tsquery('english', '!dog') AS yes, to_tsvector('english', 'cat dog') @@ to_tsquery('english', 'cat & !dog') AS no",
  },
  {
    id: "TSR-match-06",
    kind: "parity",
    setup: [
      "CREATE TABLE docs (id int, body text)",
      "INSERT INTO docs VALUES (1, 'the quick brown fox'), (2, 'lazy dogs sleep'), (3, 'foxes and dogs')",
    ],
    sql: "SELECT id FROM docs WHERE to_tsvector('english', body) @@ to_tsquery('english', 'fox') ORDER BY id",
  },
  {
    id: "TSR-cat-01",
    kind: "parity",
    sql: "SELECT (to_tsvector('english', 'black cat') || to_tsvector('english', 'white dog')) AS v",
  },
  { id: "TSR-op-01", kind: "parity", sql: "SELECT ('a'::tsquery && 'b'::tsquery)::text AS v" },
  { id: "TSR-op-02", kind: "parity", sql: "SELECT ('a'::tsquery || 'b'::tsquery)::text AS v" },
  { id: "TSR-op-03", kind: "parity", sql: "SELECT (!! 'a'::tsquery)::text AS v" },
  {
    id: "TSR-phrase-01",
    kind: "parity",
    sql: "SELECT to_tsvector('english', 'quick brown fox') @@ to_tsquery('english', 'quick <-> brown') AS adjacent, to_tsvector('english', 'quick red brown') @@ to_tsquery('english', 'quick <-> brown') AS gap",
  },
  {
    id: "TSR-phrase-02",
    kind: "parity",
    sql: "SELECT to_tsvector('english', 'one two three') @@ to_tsquery('english', 'one <2> three') AS v",
  },
  { id: "TSR-weight-01", kind: "parity", sql: "SELECT setweight(to_tsvector('english', 'cat dog'), 'A') AS v" },
  {
    id: "TSR-weight-02",
    kind: "parity",
    sql: "SELECT (setweight(to_tsvector('english', 'title words'), 'A') || setweight(to_tsvector('english', 'body words'), 'B')) AS v",
  },
  {
    id: "TSR-strip-01",
    kind: "parity",
    sql: "SELECT strip(setweight(to_tsvector('english', 'cat dog cat'), 'A')) AS v",
  },
  { id: "TSR-len-01", kind: "parity", sql: "SELECT length(to_tsvector('english', 'cat dog cat bird')) AS v" },
  {
    id: "TSR-rank-01",
    kind: "parity",
    sql: "SELECT ts_rank(to_tsvector('english', 'quick brown fox'), to_tsquery('english', 'fox')) AS v",
    options: RANK,
  },
  {
    id: "TSR-rank-02",
    kind: "parity",
    setup: [
      "CREATE TABLE docs (id int, body text)",
      "INSERT INTO docs VALUES (1, 'fox'), (2, 'fox fox fox'), (3, 'fox fox')",
    ],
    sql: "SELECT id, ts_rank(to_tsvector('english', body), to_tsquery('english', 'fox')) AS r FROM docs ORDER BY r DESC, id",
    options: RANK,
  },
  {
    id: "TSR-head-01",
    kind: "parity",
    sql: "SELECT ts_headline('english', 'The quick brown fox', to_tsquery('english', 'fox')) AS v",
  },
  {
    id: "TSR-head-02",
    kind: "parity",
    sql: "SELECT ts_headline('english', 'The quick brown fox jumps', to_tsquery('english', 'fox'), 'StartSel=<<, StopSel=>>') AS v",
  },
]);
