import { errorParity, parity, sequenceParity } from "../helpers.ts";

sequenceParity(
  "CREATE EXTENSION pg_trgm installs gin_trgm_ops and IF NOT EXISTS is a no-op",
  [],
  [
    { sql: "CREATE SCHEMA geviti" },
    { sql: 'CREATE TABLE geviti."careThreadMessages" (body text)' },
    { sql: 'CREATE TABLE geviti."careThreads" (title text)' },
    { sql: "CREATE EXTENSION IF NOT EXISTS pg_trgm" },
    {
      sql: 'CREATE INDEX care_body_trgm ON geviti."careThreadMessages" USING gin (body public.gin_trgm_ops)',
    },
    {
      sql: 'CREATE INDEX care_title_trgm ON geviti."careThreads" USING gin (title public.gin_trgm_ops)',
    },
    { sql: "CREATE EXTENSION IF NOT EXISTS pg_trgm" },
    {
      sql: `INSERT INTO geviti."careThreadMessages" (body) VALUES ('hello world'), (NULL)`,
    },
    {
      sql: `SELECT relname, relkind FROM pg_class WHERE relname IN ('care_body_trgm', 'care_title_trgm') ORDER BY relname`,
      query: true,
    },
    {
      sql: `SELECT i.indnatts, i.indisunique, i.indisprimary
            FROM pg_index i
            JOIN pg_class c ON c.oid = i.indrelid
            WHERE c.relname = 'careThreadMessages' AND c.relkind = 'r'`,
      query: true,
    },
  ],
);

sequenceParity(
  "gin_trgm_ops indexes a text expression, qualified or not, and keeps the operator class in the catalog",
  [
    "CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public",
    "CREATE TABLE public.repro (name text, label varchar(20), n int)",
  ],
  [
    { sql: "CREATE INDEX repro_idx ON public.repro USING gin (lower(name) public.gin_trgm_ops)" },
    { sql: "CREATE INDEX repro_unqualified ON public.repro USING gin (lower(name) gin_trgm_ops)" },
    { sql: "CREATE INDEX repro_dump ON public.repro USING gin (lower((name)::text) public.gin_trgm_ops)" },
    { sql: "CREATE INDEX repro_varchar ON public.repro USING gin (lower(label) gin_trgm_ops)" },
    { sql: "CREATE INDEX repro_concat ON public.repro USING gin ((name || label) gin_trgm_ops)" },
    { sql: "CREATE INDEX repro_column ON public.repro USING gin (name public.gin_trgm_ops)" },
    { sql: "INSERT INTO public.repro VALUES ('Hello World', 'Label', 1), (NULL, NULL, 2)" },
    { sql: "SELECT indexname FROM pg_indexes WHERE tablename = 'repro' ORDER BY indexname", query: true },
    {
      sql: `SELECT c.relname, i.indnatts, i.indisunique, i.indexprs IS NOT NULL AS has_expr, am.amname
            FROM pg_index i
            JOIN pg_class c ON c.oid = i.indexrelid
            JOIN pg_am am ON am.oid = c.relam
            JOIN pg_class t ON t.oid = i.indrelid
            WHERE t.relname = 'repro'
            ORDER BY c.relname`,
      query: true,
    },
    { sql: "SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'repro' ORDER BY indexname", query: true },
    { sql: "SELECT name FROM public.repro WHERE lower(name) LIKE '%world%'", query: true },
  ],
);

for (const [label, expr] of [
  ["an integer expression", "(n + 1)"],
  ["a cast to integer", "(name::int)"],
] as const) {
  errorParity(
    `gin_trgm_ops rejects ${label} as an operator class datatype mismatch`,
    ["CREATE EXTENSION pg_trgm", "CREATE TABLE repro (name text, n int)"],
    `CREATE INDEX repro_idx ON repro USING gin (${expr} gin_trgm_ops)`,
    "datatype_mismatch",
  );
}

errorParity(
  "gin_trgm_ops expression over a missing column is an undefined column",
  ["CREATE EXTENSION pg_trgm", "CREATE TABLE repro (name text)"],
  "CREATE INDEX repro_idx ON repro USING gin (lower(missing) gin_trgm_ops)",
  "undefined_column",
);

errorParity(
  "gin_trgm_ops without pg_trgm is an undefined operator class",
  ["CREATE TABLE geviti_msg (body text)"],
  "CREATE INDEX msg_body ON geviti_msg USING gin (body public.gin_trgm_ops)",
  "undefined_object",
);

parity(
  "pg_trgm similarity and <% match a fixed word list",
  [
    "CREATE EXTENSION pg_trgm",
    "CREATE TABLE words (id int, w text)",
    `INSERT INTO words VALUES
      (1, 'cat'),
      (2, 'catalog'),
      (3, 'catastrophe'),
      (4, 'dog'),
      (5, 'scatter'),
      (6, 'catch'),
      (7, 'bat'),
      (8, 'caterpillar'),
      (9, 'category'),
      (10, 'car'),
      (11, 'cats'),
      (12, 'a cat'),
      (13, 'the cat sat'),
      (14, 'dogma'),
      (15, 'cataloging'),
      (16, ''),
      (17, 'Cat'),
      (18, 'CAT'),
      (19, 'cat.'),
      (20, 'cat cat'),
      (21, NULL)`,
  ],
  `SELECT id, w, similarity(w, 'cat') AS sim
   FROM words
   ORDER BY id`,
);

parity(
  "pg_trgm <% keeps the same rows as word similarity at the default threshold",
  [
    "CREATE EXTENSION pg_trgm",
    "CREATE TABLE words (id int, w text)",
    `INSERT INTO words VALUES
      (1, 'cat'),
      (2, 'catalog'),
      (3, 'catastrophe'),
      (4, 'dog'),
      (5, 'scatter'),
      (6, 'catch'),
      (7, 'bat'),
      (8, 'caterpillar'),
      (9, 'category'),
      (10, 'car'),
      (11, 'cats'),
      (12, 'a cat'),
      (13, 'the cat sat'),
      (14, 'dogma'),
      (15, 'cataloging'),
      (16, ''),
      (17, 'Cat'),
      (18, 'CAT'),
      (19, 'cat.'),
      (20, 'cat cat'),
      (21, NULL)`,
  ],
  `SELECT id, w FROM words WHERE w <% 'cat' ORDER BY id`,
);
