import { beforeAll, describe, expect, test } from "bun:test";
import { Database } from "../../../src/index.ts";
import { expectParity } from "../../harness/assert.ts";
import { matrixBoth } from "../../harness/matrix.ts";
import { createOracleAdapter, oracleKind } from "../../harness/oracle.ts";
import { errorParity, parity, parityTyped, sequenceParity, setupBoth } from "../helpers.ts";

// pgvector 0.8.1 (`CREATE EXTENSION vector`, issue #722 / #533). The PGlite oracle loads
// @electric-sql/pglite-pgvector, so every behavior here is differential against real pgvector.
// The native oracle (embedded-postgres) ships no pgvector, so the file only runs against PGlite.

const EXT = "CREATE EXTENSION vector";
const ITEMS = [
  EXT,
  "CREATE TABLE items (id int PRIMARY KEY, content text, embedding vector(3))",
  "INSERT INTO items VALUES (1, 'a', '[1,2,3]'), (2, 'b', '[3,2,1]'), (3, 'c', '[1,2,4]'), (4, 'd', NULL), (5, 'e', '[-1.5,0.25,7]')",
];

describe.skipIf(oracleKind() !== "pglite")("pgvector", () => {
  // the first oracle query boots PGlite with every contrib extension; keep that out of a test's timeout
  beforeAll(async () => {
    const oracle = createOracleAdapter();
    await oracle.query("SELECT 1");
    await oracle.close();
  }, 60_000);

  // --- installation -------------------------------------------------------------------------

  sequenceParity(
    "the vector type exists only while the extension is installed",
    [],
    [
      { sql: "SELECT '[1,2]'::vector", query: true },
      { sql: "CREATE TABLE pre (e vector(3))" },
      { sql: "CREATE EXTENSION IF NOT EXISTS vector" },
      { sql: "CREATE EXTENSION IF NOT EXISTS vector" },
      { sql: "SELECT '[1,2]'::vector::text AS v", query: true },
      {
        sql: "SELECT name, default_version, installed_version, comment FROM pg_available_extensions WHERE name = 'vector'",
        query: true,
      },
      {
        sql: "SELECT name, version, installed, superuser, trusted, relocatable, schema, requires, comment FROM pg_available_extension_versions WHERE name = 'vector'",
        query: true,
      },
      {
        sql: "SELECT e.extname, e.extversion, n.nspname, e.extrelocatable FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace WHERE e.extname = 'vector'",
        query: true,
      },
      { sql: "SELECT typname FROM pg_type WHERE typname IN ('vector', '_vector') ORDER BY 1", query: true },
      { sql: "DROP EXTENSION vector" },
      { sql: "SELECT count(*) AS n FROM pg_extension WHERE extname = 'vector'", query: true },
      { sql: "SELECT count(*) AS n FROM pg_type WHERE typname = 'vector'", query: true },
      { sql: "SELECT '[1,2]'::vector", query: true },
    ],
  );

  errorParity("CREATE EXTENSION vector twice is a duplicate", [EXT], EXT, "duplicate_object", { messageTier: "A" });

  errorParity(
    "a vector column blocks DROP EXTENSION without CASCADE",
    [EXT, "CREATE TABLE t (id int, e vector(2))"],
    "DROP EXTENSION vector",
    undefined,
    { messageTier: "A" },
  );

  sequenceParity(
    "DROP EXTENSION vector CASCADE drops the vector columns",
    [EXT, "CREATE TABLE t (id int, e vector(2))", "INSERT INTO t VALUES (1, '[1,2]')"],
    [
      { sql: "DROP EXTENSION vector CASCADE" },
      { sql: "SELECT * FROM t", query: true },
      { sql: "SELECT count(*) AS n FROM pg_extension WHERE extname = 'vector'", query: true },
    ],
  );

  // --- the vector(n) type ---------------------------------------------------------------------

  parity(
    "a vector(n) column has format_type vector(n) and atttypmod n",
    ITEMS,
    `SELECT attname, format_type(atttypid, atttypmod) AS t, atttypmod FROM pg_attribute
     WHERE attrelid = 'items'::regclass AND attnum > 0 ORDER BY attnum`,
  );

  parity(
    "pg_typeof, regtype and format_type of vector",
    [EXT],
    `SELECT pg_typeof('[1,2]'::vector) AS a, pg_typeof(array['[1,2]'::vector]) AS b, 'vector'::regtype AS c,
            format_type('vector'::regtype, 5) AS d, format_type('vector'::regtype, -1) AS e,
            vector_dims('[1,2]'::vector(2)) AS f`,
  );

  errorParity("vector(0) is rejected", [EXT], "CREATE TABLE t (e vector(0))", "invalid_parameter", {
    messageTier: "A",
  });
  errorParity("vector(16001) is rejected", [EXT], "CREATE TABLE t (e vector(16001))", "invalid_parameter", {
    messageTier: "A",
  });

  // --- text I/O -------------------------------------------------------------------------------

  parity(
    "vector output uses float4 shortest formatting",
    [EXT],
    `SELECT '[1,2,3]'::vector::text AS a, '[1.5, 2.25 ,3e2]'::vector::text AS b, ' [ 1 , 2 ] '::vector::text AS c,
            '[0.1,0.2,0.3]'::vector::text AS d, '[1e-7, 123456789]'::vector::text AS e,
            '[0.30000001192092896]'::vector::text AS f, '[1.23456789]'::vector::text AS g,
            '[100000000]'::vector::text AS h, '[0.000001]'::vector::text AS i, '[-0]'::vector::text AS j,
            '[1e-50]'::vector::text AS k, '[+1,-2.5e1,.5,5.]'::vector::text AS l, '  [1,2]  '::vector::text AS m`,
  );

  parity("a vector column reads back as its text", ITEMS, "SELECT id, embedding FROM items ORDER BY id");

  for (const [label, sql] of [
    ["fewer dimensions than the column", "INSERT INTO items VALUES (9, 'x', '[1,2]')"],
    ["more dimensions than the cast", "SELECT '[1,2,3]'::vector(2)"],
    ["an UPDATE with the wrong dimensions", "UPDATE items SET embedding = '[9,9]'::vector WHERE id = 1"],
    ["an empty vector", "SELECT '[]'::vector"],
    ["NaN", "SELECT '[1,2,NaN]'::vector"],
    ["Infinity", "SELECT '[1,2,Infinity]'::vector"],
  ] as const) {
    errorParity(`vector input rejects ${label}`, ITEMS, sql, "data_exception", { messageTier: "A" });
  }

  for (const literal of ["[1,2,x]", "1,2,3", "[1,2,3", "[1,2,3]x", "{1,2}", "[1,,2]", "[1 2]"]) {
    errorParity(
      `vector input rejects malformed ${literal}`,
      [EXT],
      `SELECT '${literal}'::vector`,
      "invalid_text_representation",
      {
        messageTier: "A",
      },
    );
  }

  errorParity(
    "vector input rejects an out-of-range element",
    [EXT],
    "SELECT '[1e39]'::vector",
    "numeric_out_of_range",
    {
      messageTier: "A",
    },
  );

  sequenceParity(
    "UPDATE writes a vector of the right dimensions",
    ITEMS,
    [
      { sql: "UPDATE items SET embedding = '[9,9,9]'::vector WHERE id = 1" },
      { sql: "SELECT * FROM items ORDER BY id", query: true },
    ],
    { compareFinalState: true },
  );

  // --- distance operators ---------------------------------------------------------------------

  parityTyped(
    "<=>, <->, <#> and <+> return double precision",
    [EXT],
    `SELECT '[1,2,3]'::vector <=> '[1,2,4]'::vector AS cos, '[1,2,3]'::vector <-> '[1,2,4]'::vector AS l2,
            '[1,2,3]'::vector <#> '[1,2,4]'::vector AS ip, '[1,2]'::vector <+> '[3,5]'::vector AS l1`,
  );

  parity(
    "distance operators over fractional values match float4 accumulation",
    [EXT],
    `SELECT a <=> b AS cos, a <-> b AS l2, a <#> b AS ip, a <+> b AS l1
     FROM (VALUES ('[0.1,0.2,0.3,0.7,-1.3]'::vector, '[0.9,-0.4,0.33,1e-3,2.5]'::vector),
                  ('[1e10,3]'::vector, '[-2e-5,7.25]'::vector),
                  ('[0,0]'::vector, '[1,1]'::vector),
                  ('[0,0]'::vector, '[0,0]'::vector),
                  ('[1,0]'::vector, '[-1,0]'::vector)) v(a, b)`,
  );

  parity(
    "a distance operator resolves an unknown literal on either side and propagates NULL",
    [EXT],
    `SELECT '[1,2]'::vector <=> '[3,4]' AS a, '[1,2]' <=> '[3,4]'::vector AS b, '[1,2]'::vector <=> NULL AS c,
            NULL::vector <-> '[1]' AS d`,
  );

  for (const op of ["<=>", "<->", "<#>", "<+>", "+", "-", "*"]) {
    errorParity(
      `${op} rejects vectors of different dimensions`,
      [EXT],
      `SELECT '[1,2]'::vector ${op} '[1,2,3]'::vector`,
      "data_exception",
      { messageTier: "A" },
    );
  }

  parity(
    "nearest-neighbour ordering by cosine and L2 distance",
    ITEMS,
    `SELECT id, 1 - (embedding <=> '[1,2,3]') AS sim FROM items ORDER BY embedding <=> '[1,2,3]'::vector LIMIT 2`,
  );

  parity(
    "ORDER BY embedding <-> literal puts NULL last",
    ITEMS,
    "SELECT id, embedding::text FROM items ORDER BY embedding <-> '[1,2,3]' NULLS LAST",
  );

  parity(
    "ORDER BY embedding <=> $1::vector LIMIT n with a text parameter",
    ITEMS,
    "SELECT id FROM items ORDER BY embedding <=> $1::vector LIMIT 3",
    ["[1,2,3.5]"],
  );

  parity(
    "a parameter compared through <#> in WHERE",
    ITEMS,
    "SELECT id FROM items WHERE embedding <#> $1::vector < -10 ORDER BY id",
    ["[1,2,3]"],
  );

  // --- arithmetic, concatenation, comparison --------------------------------------------------

  parityTyped(
    "+, -, * and || return vectors",
    [EXT],
    `SELECT '[1,2]'::vector + '[3,4]' AS a, '[1,2]'::vector - '[3,4]' AS b, '[1,2]'::vector * '[3,4]' AS c,
            '[1,2]'::vector || '[3]'::vector AS d, '[1,2]'::vector || '[3,4,5]'::vector AS e`,
  );

  for (const [label, sql] of [
    ["+ overflow", "SELECT '[3e38]'::vector + '[3e38]'::vector"],
    ["* overflow", "SELECT '[3e38]'::vector * '[3e38]'::vector"],
    ["* underflow", "SELECT '[1e-30]'::vector * '[1e-30]'::vector"],
  ] as const) {
    errorParity(`vector ${label} is out of range`, [EXT], sql, "numeric_out_of_range", { messageTier: "A" });
  }

  parity(
    "vector comparison is element-wise, then by dimensions",
    [EXT],
    `SELECT '[1,2]'::vector = '[1,2]'::vector AS a, '[1,2]'::vector < '[1,3]'::vector AS b,
            '[1,2]'::vector < '[1,2,3]'::vector AS c, '[1,2]'::vector = '[1,2,3]'::vector AS d,
            '[2]'::vector > '[1,2]'::vector AS e, '[0]'::vector = '[-0]'::vector AS f,
            '[1,2]'::vector <> '[1,3]'::vector AS g, '[1,2]'::vector <= '[1,3]'::vector AS h,
            '[1,2]'::vector >= '[1,3]'::vector AS i`,
  );

  parity(
    "ORDER BY, DISTINCT and GROUP BY on a vector column",
    [...ITEMS, "INSERT INTO items VALUES (6, 'f', '[3,2,1]'), (7, 'g', '[0,0,9]')"],
    "SELECT embedding::text, count(*) AS n FROM items GROUP BY embedding ORDER BY embedding",
  );

  // --- functions ------------------------------------------------------------------------------

  parityTyped(
    "pgvector distance and inspection functions",
    [EXT],
    `SELECT l2_distance('[1,2]'::vector, '[3,4]'::vector) AS l2, cosine_distance('[1,0]'::vector, '[0,1]'::vector) AS cos,
            inner_product('[1,2]'::vector, '[3,4]'::vector) AS ip, l1_distance('[1,2]'::vector, '[3,5]'::vector) AS l1,
            vector_dims('[1,2,3]'::vector) AS dims, vector_norm('[3,4]'::vector) AS norm,
            vector_negative_inner_product('[1,2]'::vector, '[3,4]'::vector) AS nip,
            vector_l2_squared_distance('[1,2]'::vector, '[3,5]'::vector) AS l2sq,
            vector_spherical_distance('[1,0]'::vector, '[0,1]'::vector) AS sph`,
  );

  parityTyped(
    "subvector, l2_normalize and binary_quantize",
    [EXT],
    `SELECT subvector('[1,2,3,4]'::vector, 2, 2) AS a, subvector('[1,2,3]'::vector, 0, 2) AS b,
            subvector('[1,2,3]'::vector, 2, 5) AS c, l2_normalize('[3,4]'::vector) AS d,
            l2_normalize('[0,0]'::vector) AS e, binary_quantize('[1,-2,0,3,4,5,6,7,8,9]'::vector) AS f,
            vector_norm('[0,0]'::vector) AS g, l2_normalize('[0.1,0.2,0.3]'::vector) AS h,
            vector_norm('[0.1,0.2,0.3]'::vector) AS i`,
  );

  for (const [start, count] of [
    [5, 1],
    [1, 0],
    [-5, 2],
  ] as const) {
    errorParity(
      `subvector(v, ${start}, ${count}) is empty`,
      [EXT],
      `SELECT subvector('[1,2,3]'::vector, ${start}, ${count})`,
      "data_exception",
      { messageTier: "A" },
    );
  }

  parity(
    "the operator support functions are callable",
    [EXT],
    `SELECT array_to_vector(ARRAY[1,2], 2, true)::text AS z, vector_to_float4('[1,2]'::vector, 2, true) AS y,
            vector('[1,2]'::vector, 2, true)::text AS x,
            vector_add('[1,2]'::vector, '[3,4]'::vector)::text AS a, vector_sub('[1,2]'::vector, '[3,4]'::vector)::text AS b,
            vector_mul('[1,2]'::vector, '[3,4]'::vector)::text AS c, vector_concat('[1]'::vector, '[2]'::vector)::text AS d,
            vector_lt('[1]'::vector, '[2]'::vector) AS e, vector_eq('[1]'::vector, '[1]'::vector) AS f,
            vector_cmp('[1,2]'::vector, '[1]'::vector) AS g, vector_cmp('[1]'::vector, '[2]'::vector) AS h`,
  );

  // --- aggregates -----------------------------------------------------------------------------

  parity(
    "avg and sum of vectors skip NULLs",
    ITEMS,
    "SELECT avg(embedding)::text AS a, sum(embedding)::text AS s FROM items",
  );

  parity(
    "avg and sum of no rows are NULL",
    [EXT],
    "SELECT avg(e) IS NULL AS a, sum(e) IS NULL AS s FROM (VALUES (NULL::vector)) v(e)",
  );

  parity(
    "avg and sum per group",
    ITEMS,
    "SELECT id % 2 AS g, avg(embedding)::text AS a, sum(embedding)::text AS s FROM items GROUP BY 1 ORDER BY 1",
  );

  errorParity(
    "avg of vectors of different dimensions fails",
    [EXT],
    "SELECT avg(e) FROM (VALUES ('[1,2]'::vector), ('[1,2,3]'::vector)) v(e)",
    "data_exception",
    { messageTier: "A" },
  );

  // --- casts ----------------------------------------------------------------------------------

  parity(
    "arrays cast to vector and vector casts to real[]",
    [EXT],
    `SELECT array[1,2,3]::vector::text AS a, '[1,2]'::vector::real[] AS b, array[1.5,2]::float8[]::vector::text AS c,
            array[1,2]::numeric[]::vector::text AS d, array[1,2]::real[]::vector::text AS e,
            '{1,2}'::int[]::vector(2)::text AS f, '[1,2]'::vector::text::vector::text AS g,
            '[1,2]'::vector::varchar AS h, array['[1,2]'::vector, '[3,4]'::vector]::text AS i`,
  );

  sequenceParity(
    "an int[] or real[] is assigned to a vector column",
    [EXT, "CREATE TABLE t (id int, e vector(2))"],
    [
      { sql: "INSERT INTO t VALUES (1, ARRAY[1,2]), (2, ARRAY[1.5,2.5]::real[])" },
      { sql: "SELECT id, e FROM t ORDER BY id", query: true },
    ],
  );

  for (const [label, sql] of [
    ["an array with NULLs", "SELECT array[1,null]::int[]::vector"],
    ["a 2-D array", "SELECT array[[1,2],[3,4]]::int[]::vector"],
    ["an empty array", "SELECT '{}'::int[]::vector"],
    ["an array of the wrong length", "SELECT array[1,2]::int[]::vector(3)"],
  ] as const) {
    errorParity(`casting ${label} to vector fails`, [EXT], sql, undefined, { messageTier: "A" });
  }

  errorParity("vector does not cast to float8[]", [EXT], "SELECT '[1,2]'::vector::float8[]", "datatype_mismatch", {
    messageTier: "A",
  });

  // --- indexes --------------------------------------------------------------------------------

  sequenceParity("hnsw and ivfflat indexes are accepted and shown like PostgreSQL", ITEMS, [
    { sql: "CREATE INDEX ON items USING hnsw (embedding vector_cosine_ops)" },
    { sql: "CREATE INDEX ON items USING ivfflat (embedding vector_l2_ops) WITH (lists = 100)" },
    { sql: "CREATE INDEX ON items USING hnsw (embedding vector_ip_ops) WITH (m = 16, ef_construction = 64)" },
    { sql: "CREATE INDEX ON items USING hnsw (embedding vector_l1_ops)" },
    { sql: "CREATE INDEX items_ivf_ip ON items USING ivfflat (embedding vector_ip_ops) WITH (lists = 1)" },
    { sql: "CREATE INDEX items_btree ON items (embedding)" },
    { sql: "SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'items' ORDER BY indexname", query: true },
    { sql: "INSERT INTO items VALUES (8, 'h', '[2,2,2]')" },
    {
      sql: "SELECT id FROM items ORDER BY embedding <=> '[1,2,3]' LIMIT 3",
      query: true,
    },
  ]);

  for (const [label, sql] of [
    ["hnsw without an operator class", "CREATE INDEX ON items USING hnsw (embedding)"],
    ["an out-of-range hnsw m", "CREATE INDEX ON items USING hnsw (embedding vector_l2_ops) WITH (m = 1)"],
    [
      "ef_construction below 2 * m",
      "CREATE INDEX ON items USING hnsw (embedding vector_l2_ops) WITH (m = 32, ef_construction = 40)",
    ],
    ["vector_l1_ops on ivfflat", "CREATE INDEX ON items USING ivfflat (embedding vector_l1_ops)"],
    ["an out-of-range ivfflat lists", "CREATE INDEX ON items USING ivfflat (embedding) WITH (lists = 0)"],
    ["an unknown ivfflat option", "CREATE INDEX ON items USING ivfflat (embedding) WITH (foo = 1)"],
    ["ivfflat on an integer column", "CREATE INDEX ON items USING ivfflat (id)"],
    ["a vector operator class on an integer column", "CREATE INDEX ON items USING ivfflat (id vector_l2_ops)"],
    ["a multicolumn ivfflat index", "CREATE INDEX ON items USING ivfflat (embedding, id)"],
    ["a unique hnsw index", "CREATE UNIQUE INDEX ON items USING hnsw (embedding vector_l2_ops)"],
    ["an expression without dimensions", "CREATE INDEX ON items USING hnsw ((embedding + embedding) vector_l2_ops)"],
    ["a column without dimensions", "CREATE INDEX ON loose USING hnsw (v vector_l2_ops)"],
    ["a column wider than 2000 dimensions", "CREATE INDEX ON wide USING ivfflat (v)"],
    ["hnsw without pgvector", "CREATE INDEX ON plain USING hnsw (id)"],
  ] as const) {
    errorParity(
      `CREATE INDEX rejects ${label}`,
      [...ITEMS, "CREATE TABLE loose (v vector)", "CREATE TABLE wide (v vector(2001))", "CREATE TABLE plain (id int)"],
      sql,
      undefined,
      { messageTier: "A" },
    );
  }

  sequenceParity("an index over an expression cast to vector(n), and the access method in pg_am", ITEMS, [
    { sql: "CREATE INDEX items_sum ON items USING hnsw (((embedding + embedding)::vector(3)) vector_l2_ops)" },
    { sql: "CREATE INDEX items_ivf ON items USING ivfflat (embedding)" },
    {
      sql: `SELECT c.relname, am.amname FROM pg_class c JOIN pg_am am ON am.oid = c.relam
              WHERE c.relname IN ('items_sum', 'items_ivf') ORDER BY 1`,
      query: true,
    },
    { sql: "SELECT indexdef FROM pg_indexes WHERE indexname = 'items_sum'", query: true },
  ]);

  // --- parameters, views and the information schema -----------------------------------------

  sequenceParity(
    "text parameters bind to vector columns and operands without a cast",
    [EXT, "CREATE TABLE items (id int, e vector(3))"],
    [
      { sql: "INSERT INTO items VALUES ($1, $2)", params: [1, "[1,2,3]"] },
      { sql: "INSERT INTO items VALUES ($1, $2::vector)", params: [2, "[3,2,1]"] },
      { sql: "SELECT id FROM items ORDER BY e <=> $1 LIMIT 3", params: ["[1,2,3.5]"], query: true },
      { sql: "SELECT id, e <-> $1 AS d FROM items ORDER BY 2", params: ["[1,1,2]"], query: true },
      { sql: "SELECT l2_distance(e, $1) AS d FROM items ORDER BY 1", params: ["[1,1,1]"], query: true },
      { sql: "UPDATE items SET e = $1 WHERE id = 1", params: ["[0,0,1]"] },
      { sql: "SELECT id, e FROM items WHERE e = $1", params: ["[0,0,1]"], query: true },
    ],
  );

  sequenceParity("a view over a distance keeps the vector literal", ITEMS, [
    { sql: "CREATE VIEW nearest AS SELECT id, embedding <=> '[1,1,1]' AS d FROM items" },
    { sql: "SELECT pg_get_viewdef('nearest')", query: true },
    { sql: "SELECT * FROM nearest ORDER BY id", query: true },
  ]);

  parity(
    "information_schema.columns reports vector as USER-DEFINED",
    [...ITEMS, "CREATE TABLE loose (v vector, a vector(3)[])"],
    `SELECT table_name, column_name, data_type, udt_name FROM information_schema.columns
     WHERE table_name IN ('items', 'loose') ORDER BY table_name, ordinal_position`,
  );

  sequenceParity(
    "an unconstrained vector column holds any dimension count",
    [EXT, "CREATE TABLE loose (v vector)"],
    [
      { sql: "INSERT INTO loose VALUES ('[1]'), ('[1,2]'), ('[0.5,0.5,0.5]')" },
      { sql: "SELECT v, vector_dims(v) FROM loose ORDER BY v", query: true },
      {
        sql: "SELECT format_type(atttypid, atttypmod) FROM pg_attribute WHERE attrelid = 'loose'::regclass AND attname = 'v'",
        query: true,
      },
    ],
  );

  parity(
    "vector arrays print each element quoted as needed",
    [EXT],
    `SELECT ARRAY['[1,2]'::vector] AS a, '{"[1,2]","[3]"}'::vector[] AS b, '[0x10]'::vector AS c,
            '[3.4028235e38]'::vector AS d`,
  );

  for (const [label, sql] of [
    ["vector <=> integer", "SELECT '[1,2]'::vector <=> 5"],
    ["vector + integer", "SELECT '[1,2]'::vector + 1"],
    ["real[] <-> vector", "SELECT ARRAY[1,2]::real[] <-> '[1,3]'::vector"],
  ] as const) {
    errorParity(`${label} does not exist`, [EXT], sql, "undefined_function", { messageTier: "A" });
  }

  errorParity("unknown <-> unknown is ambiguous", [EXT], "SELECT '[1,2]' <-> '[3,4]'", "ambiguous", {
    messageTier: "A",
  });

  errorParity("vector(n) takes one modifier", [EXT], "SELECT '[1,2]'::vector(1,2)", "invalid_parameter", {
    messageTier: "A",
  });

  // --- bit-string distances -------------------------------------------------------------------

  parity(
    "hamming and jaccard distance over bit strings",
    [EXT],
    `SELECT '101'::bit(3) <~> '111'::bit(3) AS h, '101'::bit(3) <%> '111'::bit(3) AS j,
            hamming_distance('101'::bit(3), '011'::bit(3)) AS h2, jaccard_distance('000'::bit(3), '000'::bit(3)) AS j2,
            binary_quantize('[1,-1,2]'::vector) <~> binary_quantize('[1,1,-2]'::vector) AS q`,
  );

  errorParity(
    "hamming_distance of bit strings of different lengths fails",
    [EXT],
    "SELECT hamming_distance('101'::bit(3), '01'::bit(2))",
    "data_exception",
    { messageTier: "A" },
  );

  // --- float4 accumulation over realistic embedding sizes -----------------------------------

  for (const dims of [64, 384, 1536]) {
    const a = embedding(dims, 1);
    const b = embedding(dims, 2);
    parity(
      `distances, norm, normalization and avg over ${dims} dimensions`,
      [EXT],
      `SELECT '${a}'::vector <-> '${b}' AS l2, '${a}'::vector <=> '${b}' AS cos, '${a}'::vector <#> '${b}' AS ip,
              '${a}'::vector <+> '${b}' AS l1, vector_norm('${a}') AS norm,
              md5(l2_normalize('${a}'::vector)::text) AS normalized,
              md5((SELECT avg(x) FROM (VALUES ('${a}'::vector), ('${b}'::vector)) t(x))::text) AS average,
              md5(('${a}'::vector + '${b}')::text) AS added, md5(('${a}'::vector * '${b}')::text) AS product`,
    );
  }

  matrixBoth("a vector table survives a snapshot reload", async (memory, postgres) => {
    await setupBoth(memory, postgres, ITEMS);
    memory.restore(memory.snapshot());
    for (const sql of [
      "SELECT id, embedding::text, embedding <-> '[1,1,1]' AS d FROM items ORDER BY id",
      "SELECT format_type(atttypid, atttypmod) AS t FROM pg_attribute WHERE attrelid = 'items'::regclass AND attname = 'embedding'",
      "SELECT extname, extversion FROM pg_extension WHERE extname = 'vector'",
    ]) {
      expectParity(await memory.query(sql), await postgres.query(sql));
    }
    const bad = "INSERT INTO items VALUES (9, 'x', '[1,2]')";
    expectParity(await memory.exec(bad), await postgres.exec(bad), { ignoreWriteCounters: true, messageTier: "A" });
  });
});

// halfvec and sparsevec are not modelled: with pgvector installed they fail loud rather than
// resolving to something else (the oracle has them, so this is engine-only).
test("halfvec and sparsevec are explicitly unsupported", () => {
  const db = new Database();
  try {
    db.exec("CREATE EXTENSION vector");
    for (const sql of ["SELECT '[1,2,3]'::halfvec", "SELECT '{1:1}/3'::sparsevec", "CREATE TABLE t (e halfvec(3))"]) {
      expect(() => db.query(sql)).toThrow(expect.objectContaining({ sqlState: "0A000" }));
    }
  } finally {
    db.close();
  }
});

/** A deterministic pseudo-random embedding with six-decimal components in [-3, 3). */
function embedding(dims: number, seed: number): string {
  let state = seed * 0x9e3779b1;
  const next = () => {
    state = (Math.imul(state ^ (state >>> 15), 0x2c1b3c6d) + 0x6d2b79f5) | 0;
    return ((state >>> 0) % 6_000_000) / 1_000_000 - 3;
  };
  return `[${Array.from({ length: dims }, () => next().toFixed(6)).join(",")}]`;
}
