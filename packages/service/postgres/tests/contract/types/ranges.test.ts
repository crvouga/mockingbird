import { expect, test } from "bun:test";
import { Database, Snapshot } from "../../../src/index.ts";
import { execParity, parity, parityTyped, queryErrorParity, sequenceParity } from "../helpers.ts";

// #692: the built-in range types, their constructors, accessors and operators.

parity(
  "range constructors canonicalize discrete ranges",
  [],
  "SELECT int4range(1, 5)::text AS a, int4range(1, 5, '[]')::text AS b, int4range(1, 5, '()')::text AS c, int4range(1, 5, '(]')::text AS d, int8range(1, 2)::text AS e, int4range(1, 1)::text AS f, int4range(NULL, NULL)::text AS g",
);
parity(
  "continuous range constructors keep the bounds as given",
  [],
  "SELECT numrange(1.5, 2)::text AS a, numrange(1.0, 2.50)::text AS b, numrange(1.0, 1.00)::text AS c, numrange(1, 5, '[]')::text AS d, tsrange('2026-01-01', '2026-01-02')::text AS e, daterange('2026-01-01', '2026-01-05', '[]')::text AS f",
);
parity(
  "tstzrange renders in the session time zone",
  ["SET timezone = 'America/New_York'"],
  "SELECT tstzrange('2026-01-01 00:00+00', '2026-01-02 00:00+00')::text AS a, '[\"2026-01-01 10:00+00\",)'::tstzrange::text AS b",
);
parity(
  "daterange keeps infinite bounds as written",
  [],
  "SELECT daterange('2026-01-01', 'infinity')::text AS a, daterange('-infinity', '2026-01-01', '(]')::text AS b",
);
parity(
  "range literal input",
  [],
  "SELECT '[1,5]'::int4range::text AS a, '(1,1)'::int4range::text AS b, '[,)'::int4range::text AS c, 'EMPTY'::int4range::text AS d, '  [ 1, 2 )  '::int4range::text AS e, '(\"1\",\"2\")'::int4range::text AS f, '[1.5,1.5]'::numrange::text AS g, '(1.5,1.5]'::numrange::text AS h",
);
parityTyped(
  "range constructor and accessor result types",
  [],
  "SELECT int4range(1, 2) AS a, numrange(1, 2) AS b, lower(numrange(1, 2)) AS c, upper(daterange('2026-01-01', '2026-01-02')) AS d, isempty(int4range(1, 2)) AS e",
);
parity(
  "range accessors",
  [],
  "SELECT lower(int4range(1, 5)) AS a, upper(int4range(1, 5)) AS b, isempty(int4range(1, 1)) AS c, lower_inc(int4range(1, 5)) AS d, upper_inc(int4range(1, 5)) AS e, lower_inf('(,5)'::int4range) AS f, upper_inf(int4range(1, NULL)) AS g, lower(int4range(NULL, 5)) AS h, upper('empty'::int4range) AS i, lower_inc('empty'::int4range) AS j, lower_inf('empty'::int4range) AS k, lower('ABC') AS l, upper('abc') AS m",
);
parity(
  "range containment, overlap and position operators",
  [],
  "SELECT int4range(1, 5) @> 3 AS a, 3 <@ int4range(1, 5) AS b, int4range(1, 5) @> int4range(2, 3) AS c, int4range(1, 5) << int4range(5, 7) AS d, int4range(1, 5) -|- int4range(5, 7) AS e, int4range(1, 5) &< int4range(2, 3) AS f, int4range(1, 5) &> int4range(2, 3) AS g, int4range(30, 40) >> int4range(20, 30) AS h, 'empty'::int4range << int4range(1, 2) AS i, 'empty'::int4range <@ int4range(1, 2) AS j, int4range(1, 5) @> NULL::int4 AS k",
);
parity(
  "tstzrange overlap (the booking check)",
  [],
  "SELECT (tstzrange('2026-01-01', '2026-01-02') && tstzrange('2026-01-01 12:00', '2026-01-03'))::text AS overlaps",
);
parity(
  "adjacency of continuous ranges depends on inclusivity",
  [],
  "SELECT numrange(1, 2) -|- numrange(2, 3, '(]') AS a, numrange(1, 2) -|- numrange(2, 3) AS b, numrange(1, 2, '[]') -|- numrange(2, 3, '(]') AS c",
);
parity(
  "range union, intersection and difference",
  [],
  "SELECT int4range(1, 5) + int4range(5, 7) AS a, int4range(1, 5) * int4range(3, 7) AS b, int4range(1, 10) - int4range(1, 3) AS c, int4range(1, 10) - int4range(8, 12) AS d, int4range(1, 10) - int4range(20, 30) AS e, int4range(1, 10) * int4range(20, 30) AS f, int4range(NULL, 5) - int4range(3, NULL) AS g, numrange(1, 5, '[]') - numrange(5, 6) AS h, numrange(1, 5, '[]') - numrange(1, 5) AS i, range_merge(int4range(1, 2), int4range(5, 7)) AS j, range_merge(int4range(1, 2), 'empty') AS k",
);
parity(
  "an unknown literal against a range reads as that range type",
  [],
  "SELECT int4range(1, 5) @> '[2,3)' AS a, '[2,3)' <@ int4range(1, 5) AS b, int4range(1, 5) && '[2,3)' AS c, int4range(1, 5) = '[1,5)' AS d, int4range(1, 5) < '[2,3)' AS e, int4range(1, 5) + '[5,7)' AS f",
);
parity(
  "range ordering, equality and grouping",
  [],
  "SELECT r::text AS r, count(*) AS n FROM (VALUES (int4range(3, 5)), ('empty'), (int4range(1, 9)), (int4range(NULL, 2)), (int4range(1, 3)), ('[1,2]'), (int4range(1, 3))) v(r) GROUP BY r ORDER BY r",
);
parity("range arrays", [], "SELECT ARRAY[int4range(1, 2), '[3,4]']::text AS a, (ARRAY[int4range(1, 2)])[1] AS b");

sequenceParity(
  "range columns: storage, unique keys, filters and ORDER BY",
  [
    "CREATE TABLE booking (id int PRIMARY KEY, room int, during tstzrange, days daterange, UNIQUE (room, during))",
    "INSERT INTO booking VALUES (1, 1, '[2026-01-01 10:00, 2026-01-01 12:00)', '[2026-01-01,2026-01-03]'), (2, 1, tstzrange('2026-01-01 13:00', '2026-01-01 14:00'), daterange('2026-01-05', NULL)), (3, 2, '(,)', 'empty')",
  ],
  [
    { sql: "INSERT INTO booking (id, room, during) VALUES (4, 1, '[2026-01-01 10:00, 2026-01-01 12:00)')" },
    { sql: "SELECT id, during, days, lower(days), upper_inf(days) FROM booking ORDER BY during", query: true },
    {
      sql: "SELECT id FROM booking WHERE during && tstzrange('2026-01-01 11:00', '2026-01-01 13:30') ORDER BY id",
      query: true,
    },
    { sql: "SELECT id FROM booking WHERE during @> '2026-01-01 13:30+00'::timestamptz ORDER BY id", query: true },
    { sql: "SELECT DISTINCT days FROM booking ORDER BY days", query: true },
    {
      sql: "UPDATE booking SET days = days * daterange('2026-01-02', '2026-01-10') WHERE id = 1 RETURNING days",
      query: true,
    },
  ],
  { compareFinalState: true },
);
execParity(
  "range literal into a range array column",
  ["CREATE TABLE r2 (r int4range[])"],
  'INSERT INTO r2 VALUES (\'{"[1,2)","[3,4]"}\')',
);

queryErrorParity("reversed range bounds", [], "SELECT int4range(5, 1)", "data_exception");
queryErrorParity("reversed range literal", [], "SELECT '[3,1)'::int4range", "data_exception");
queryErrorParity("bad range flags", [], "SELECT int4range(1, 5, 'x')", "syntax");
queryErrorParity("null range flags", [], "SELECT int4range(1, 5, NULL)", "data_exception");
queryErrorParity("discontiguous range union", [], "SELECT int4range(1, 3) + int4range(5, 7)", "data_exception");
queryErrorParity("discontiguous range difference", [], "SELECT int4range(1, 10) - int4range(3, 4)", "data_exception");
queryErrorParity("discrete upper bound overflow", [], "SELECT int4range(1, 2147483647, '[]')", "numeric_out_of_range");
queryErrorParity("malformed range literals", [], "SELECT '[1,2'::int4range", "invalid_text_representation");
queryErrorParity("too many range commas", [], "SELECT '[1,2,3)'::int4range", "invalid_text_representation");
queryErrorParity("junk after a range literal", [], "SELECT '[1,2) x'::int4range", "invalid_text_representation");
queryErrorParity("bad range bound", [], "SELECT '[a,b)'::int4range", "invalid_text_representation");
queryErrorParity("unknown element against a range", [], "SELECT int4range(1, 5) @> '3'", "invalid_text_representation");
queryErrorParity("range of another element type", [], "SELECT int4range(1, 5) @> 3::int8", "undefined_function");
queryErrorParity("ranges of different types", [], "SELECT int4range(1, 5) = int8range(1, 5)", "undefined_function");
queryErrorParity("range constructor argument types", [], "SELECT int4range(1::int8, 2)", "undefined_function");
// #692: multiranges are modelled now (tests/contract/issue-692/multiranges.test.ts)
test("a multirange column and range_agg", () => {
  const db = new Database();
  db.exec("CREATE TABLE m (r int4multirange)");
  expect(db.query("SELECT range_agg(int4range(1, 2))::text AS r")).toEqual([{ r: "{[1,2)}" }]);
});

test("range values survive an encoded snapshot", () => {
  const db = new Database();
  db.exec(`CREATE TABLE b (id int, r tstzrange, d daterange, n numrange);
    INSERT INTO b VALUES (1, '["2026-01-01 10:00+00","2026-01-01 12:00+00")', '[2026-01-01,)', 'empty'), (2, NULL, '(,)', '[1.50,2]')`);
  const restored = Snapshot.decode(db.snapshot().encode()).open();
  expect(restored.query("SELECT id, r::text AS r, d::text AS d, n::text AS n FROM b ORDER BY id")).toEqual([
    { id: 1, r: '["2026-01-01 10:00:00+00","2026-01-01 12:00:00+00")', d: "[2026-01-01,)", n: "empty" },
    { id: 2, r: null, d: "(,)", n: "[1.50,2]" },
  ]);
  expect(restored.query("SELECT id FROM b WHERE d @> '2026-06-01'::date ORDER BY id")).toEqual([{ id: 1 }, { id: 2 }]);
  db.close();
  restored.close();
});
