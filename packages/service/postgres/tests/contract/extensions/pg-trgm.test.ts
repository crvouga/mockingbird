import { errorParity, parity, parityTyped, sequenceParity } from "../helpers.ts";

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

// --- issue #720: the rest of pg_trgm's operators, functions and settings -------------------------

errorParity(
  "text % text does not exist before pg_trgm is installed",
  [],
  "SELECT 'hello'::text % 'hallo'::text",
  "undefined_function",
);

errorParity(
  "word_similarity does not exist before pg_trgm is installed",
  [],
  "SELECT word_similarity('a', 'b')",
  "undefined_function",
);

errorParity("%> does not exist before pg_trgm is installed", [], "SELECT 'a'::text %> 'b'::text", "undefined_function");

parity(
  "% compares similarity against pg_trgm.similarity_threshold",
  ["CREATE EXTENSION pg_trgm"],
  "SELECT 'hello'::text % 'hallo'::text AS a, 'hello' % 'world' AS b, 'abc' % 'abc' AS c, 'a'::varchar % 'a' AS d, 'a'::name % 'a' AS e",
);

parity(
  "% keeps integer modulo for numbers once pg_trgm is installed",
  ["CREATE EXTENSION pg_trgm"],
  "SELECT 7 % 3 AS a, 5.5 % 2 AS b",
);

errorParity(
  "% with text and an integer is not a trigram match",
  ["CREATE EXTENSION pg_trgm"],
  "SELECT 'abc' % 3",
  "invalid_text_representation",
);

parityTyped(
  "<-> is one minus similarity, as real",
  ["CREATE EXTENSION pg_trgm"],
  "SELECT 'hello'::text <-> 'hallo'::text AS d, similarity('hello', 'hallo') AS s, 'a' <-> 'a' AS same",
);

parityTyped(
  "word_similarity, strict_word_similarity and the word operators",
  ["CREATE EXTENSION pg_trgm"],
  `SELECT word_similarity('word', 'two words') AS ws, strict_word_similarity('word', 'two words') AS sws,
          'word' <% 'two words' AS a, 'two words' %> 'word' AS b, 'word' <<% 'two words' AS c, 'two words' %>> 'word' AS d`,
);

parityTyped(
  "word distance operators",
  ["CREATE EXTENSION pg_trgm"],
  `SELECT 'word' <<-> 'two words' AS a, 'two words' <->> 'word' AS b,
          'word' <<<-> 'two words' AS c, 'two words' <->>> 'word' AS d`,
);

parity(
  "strict_word_similarity snaps the extent to word bounds",
  ["CREATE EXTENSION pg_trgm"],
  `SELECT strict_word_similarity('word', 'words two') AS a, strict_word_similarity('ord', 'two words') AS b,
          strict_word_similarity('two wo', 'two words') AS c, word_similarity('', '') AS d, similarity('', '') AS e,
          word_similarity('abc', '') AS f, word_similarity('hel', 'hello') AS g`,
);

parity(
  "the trigram operators return NULL for a NULL operand",
  ["CREATE EXTENSION pg_trgm"],
  "SELECT 'abc' <-> NULL AS a, NULL % 'a' AS b, 'a' <<% NULL AS c, NULL %>> 'a' AS d, 'a' <->>> NULL AS e",
);

parityTyped(
  "show_trgm lists sorted trigrams, hashing non-ASCII ones",
  ["CREATE EXTENSION pg_trgm"],
  `SELECT show_trgm('hello') AS a, show_trgm('Hello World!') AS b, show_trgm('') AS c, show_trgm('a-b') AS d,
          show_trgm('ÄÖ ab') AS e, show_trgm('über') AS f, show_trgm('日本語') AS g, show_trgm('naïve café') AS h,
          show_trgm('a_b') AS i, show_trgm('ab12 x9') AS j`,
);

parity(
  "similarity folds case of non-ASCII letters",
  ["CREATE EXTENSION pg_trgm"],
  "SELECT similarity('Über', 'über') AS a, similarity('ÄÖ', 'äö') AS b, word_similarity('café', 'le café noir') AS c",
);

parityTyped(
  "show_limit and the pg_trgm thresholds start at their defaults",
  ["CREATE EXTENSION pg_trgm"],
  `SELECT show_limit() AS l, current_setting('pg_trgm.similarity_threshold') AS s,
          current_setting('pg_trgm.word_similarity_threshold') AS w,
          current_setting('pg_trgm.strict_word_similarity_threshold') AS sw`,
);

sequenceParity(
  "SET, set_limit and set_config move the similarity threshold",
  ["CREATE EXTENSION pg_trgm"],
  [
    { sql: "SET pg_trgm.similarity_threshold = 0.1" },
    { sql: "SELECT 'hello' % 'world' AS m, show_limit() AS l", query: true },
    { sql: "SHOW pg_trgm.similarity_threshold", query: true },
    { sql: "SELECT set_limit(0.5) AS l", query: true },
    { sql: "SELECT show_limit() AS l, current_setting('pg_trgm.similarity_threshold') AS s", query: true },
    { sql: "SELECT set_config('pg_trgm.similarity_threshold', '0.4', false) AS c, show_limit() AS l", query: true },
    { sql: "RESET pg_trgm.similarity_threshold" },
    { sql: "SHOW pg_trgm.similarity_threshold", query: true },
    { sql: "SET pg_trgm.word_similarity_threshold = 0.10" },
    { sql: "SHOW pg_trgm.word_similarity_threshold", query: true },
    { sql: "SELECT 'word' <% 'two words' AS a, 'word' <% 'xyz' AS b", query: true },
    { sql: "SET pg_trgm.strict_word_similarity_threshold = '.25'" },
    { sql: "SELECT current_setting('pg_trgm.strict_word_similarity_threshold') AS s", query: true },
    { sql: "SELECT 'ord' <<% 'two words' AS a", query: true },
    { sql: "SET pg_trgm.strict_word_similarity_threshold = 1" },
    { sql: "SHOW pg_trgm.strict_word_similarity_threshold", query: true },
  ],
);

sequenceParity(
  "a pg_trgm threshold set before the extension is installed is kept",
  [],
  [
    { sql: "SET pg_trgm.similarity_threshold = 0.2" },
    { sql: "SELECT current_setting('pg_trgm.similarity_threshold') AS s", query: true },
    { sql: "CREATE EXTENSION pg_trgm" },
    { sql: "SHOW pg_trgm.similarity_threshold", query: true },
    { sql: "SELECT show_limit() AS l", query: true },
  ],
);

for (const [label, sql] of [
  ["above the range", "SET pg_trgm.similarity_threshold = 1.5"],
  ["not a number", "SET pg_trgm.similarity_threshold = 'abc'"],
  ["set_limit above the range", "SELECT set_limit(2)"],
  ["set_limit below the range", "SELECT set_limit(-0.1)"],
] as const) {
  errorParity(`a pg_trgm threshold ${label} is rejected`, ["CREATE EXTENSION pg_trgm"], sql, "invalid_parameter");
}

errorParity(
  "an unknown pg_trgm setting is an invalid parameter name once pg_trgm is loaded",
  ["CREATE EXTENSION pg_trgm"],
  "SET pg_trgm.bogus = 1",
);

parity(
  "pg_trgm word operators over a fixed word list",
  [
    "CREATE EXTENSION pg_trgm",
    "CREATE TABLE words (id int, w text)",
    `INSERT INTO words VALUES (1, 'cat'), (2, 'catalog'), (3, 'the cat sat'), (4, 'dog'), (5, 'scatter'),
      (6, 'a catalogue of cats'), (7, ''), (8, NULL), (9, 'Cat-Alog'), (10, 'concatenate strings')`,
  ],
  `SELECT id, w % 'catalog' AS s, w <-> 'catalog' AS d, 'cat' <% w AS ws, w %> 'cat' AS wsc,
          'catalog' <<% w AS sws, w %>> 'catalog' AS swsc, 'cat' <<-> w AS wd, w <->> 'cat' AS wdc,
          'catalog' <<<-> w AS swd, w <->>> 'catalog' AS swdc, word_similarity('catalog', w) AS ws2,
          strict_word_similarity('catalog', w) AS sws2
   FROM words ORDER BY id`,
);
