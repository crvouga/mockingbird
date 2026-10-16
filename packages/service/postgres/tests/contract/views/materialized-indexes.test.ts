import { errorParity, sequenceParity } from "../helpers.ts";

const setup = [
  "CREATE TABLE source_rows (id int, status text)",
  "CREATE MATERIALIZED VIEW saved_rows AS SELECT id, status FROM source_rows WITH NO DATA",
];
sequenceParity("ordinary, partial and unique matview indexes before population (#431)", setup, [
  { sql: "CREATE INDEX saved_partial ON saved_rows USING btree (id) WHERE status = 'completed'::text" },
  { sql: "CREATE UNIQUE INDEX saved_unique ON saved_rows (id)" },
  { sql: "SELECT relhasindex FROM pg_class WHERE relname = 'saved_rows'", query: true },
  { sql: "INSERT INTO source_rows VALUES (1, 'completed')" },
  { sql: "CREATE TABLE unrelated (id int)" },
  { sql: "REFRESH MATERIALIZED VIEW saved_rows" },
  { sql: "SELECT * FROM saved_rows", query: true },
  { sql: "SELECT indexname FROM pg_indexes WHERE tablename = 'saved_rows' ORDER BY indexname", query: true },
  {
    sql: "SELECT count(*) FROM pg_index i JOIN pg_class c ON c.oid = i.indrelid WHERE c.relname = 'saved_rows'",
    query: true,
  },
]);
errorParity("matview index invalid column (#431)", setup, "CREATE INDEX bad ON saved_rows (missing)");
errorParity(
  "matview unique index validates refresh atomically (#431)",
  [...setup, "CREATE UNIQUE INDEX saved_unique ON saved_rows(id)", "INSERT INTO source_rows VALUES (1, 'a'), (1, 'b')"],
  "REFRESH MATERIALIZED VIEW saved_rows",
);
sequenceParity(
  "failed refresh preserves matview and index (#431)",
  [
    ...setup,
    "CREATE UNIQUE INDEX saved_unique ON saved_rows(id)",
    "INSERT INTO source_rows VALUES (1, 'a')",
    "REFRESH MATERIALIZED VIEW saved_rows",
  ],
  [
    { sql: "INSERT INTO source_rows VALUES (1, 'b')" },
    { sql: "REFRESH MATERIALIZED VIEW saved_rows" },
    { sql: "SELECT * FROM saved_rows", query: true },
  ],
);
