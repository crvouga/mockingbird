import { expect, test } from "bun:test";
import { Database, Snapshot } from "../../../src/index.ts";
import { parity, parityTyped, queryErrorParity, sequenceParity } from "../helpers.ts";

// #692: multirange types — I/O, constructors, operators, accessors, unnest, range_agg.

parity(
  "multirange literals are canonicalized",
  [],
  "SELECT '{[1,2), [5,6)}'::int4multirange AS a, '{}'::int4multirange AS b, '{[1,3],[2,8),empty}'::int4multirange AS c, '{(1,2]}'::int4multirange AS d, '{[1.5,2), [2,3)}'::nummultirange AS e",
);
parity(
  "constructors, multirange() and the range cast",
  [],
  "SELECT int4multirange() AS a, int4multirange(int4range(1,3), int4range(10,12), int4range(2,5)) AS b, multirange(int4range(1,2)) AS c, int4range(3,4)::int4multirange AS d",
);
parity(
  "containment",
  [],
  "SELECT '{[1,5)}'::int4multirange @> 3 AS a, '{[1,5)}'::int4multirange @> int4range(2,3) AS b, '{[1,5),[7,9)}'::int4multirange @> '{[2,3),[7,8)}'::int4multirange AS c, int4range(1,10) @> '{[2,3)}'::int4multirange AS d, 3 <@ '{[1,5)}'::int4multirange AS e, '{[1,5)}'::int4multirange <@ int4range(0, 9) AS f",
);
parity(
  "overlap and position operators",
  [],
  "SELECT '{[1,5)}'::int4multirange && int4range(4,6) AS a, '{[1,5)}'::int4multirange && '{[5,6)}'::int4multirange AS b, '{[1,5)}'::int4multirange << '{[6,7)}'::int4multirange AS c, '{[1,5)}'::int4multirange >> int4range(-3,0) AS d, '{[1,5)}'::int4multirange &< int4range(0,5) AS e, '{[1,5)}'::int4multirange &> int4range(0,5) AS f, '{[1,5)}'::int4multirange -|- int4range(5,9) AS g",
);
parity(
  "union, intersection and difference",
  [],
  "SELECT '{[1,5)}'::int4multirange + '{[3,9),[20,21)}'::int4multirange AS u, '{[1,5),[8,12)}'::int4multirange * '{[3,10)}'::int4multirange AS i, '{[1,10)}'::int4multirange - '{[3,4),[6,7)}'::int4multirange AS d, '{[1,10)}'::int4multirange - '{[0,20)}'::int4multirange AS e",
);
parity(
  "ordering",
  [],
  "SELECT '{[1,2)}'::int4multirange = '{[1,2)}'::int4multirange AS eq, '{[1,2)}'::int4multirange < '{[1,3)}'::int4multirange AS lt, '{[1,2)}'::int4multirange < '{[1,2),[5,6)}'::int4multirange AS lt2, '{}'::int4multirange < '{[1,2)}'::int4multirange AS lt3",
);
parity(
  "accessors and range_merge",
  [],
  "SELECT lower('{[1,2),[5,6)}'::int4multirange), upper('{[1,2),[5,6)}'::int4multirange), isempty('{}'::int4multirange), lower_inf('{(,2)}'::int4multirange), upper_inc('{[1,2]}'::nummultirange), range_merge('{[1,2),[5,6)}'::int4multirange)",
);
parity("unnest(multirange)", [], "SELECT * FROM unnest('{[1,2),[5,6)}'::int4multirange)");
const ranges = [
  "CREATE TABLE b (id int, r int4range)",
  "INSERT INTO b VALUES (1, '[1,3)'), (1, '[2,5)'), (1, '[8,9)'), (2, NULL), (3, '[1,2)')",
];
parity(
  "range_agg and range_intersect_agg",
  ranges,
  "SELECT id, range_agg(r), range_intersect_agg(r) FROM b GROUP BY id ORDER BY id",
);
parity(
  "range_agg over multiranges",
  [],
  "SELECT range_agg(m) FROM (VALUES ('{[1,2)}'::int4multirange), ('{[2,4),[7,8)}')) v(m)",
);
parity(
  "date and timestamp multiranges",
  [],
  "SELECT '{[2024-01-01,2024-01-05)}'::datemultirange, '{[\"2024-01-01 00:00\",\"2024-01-02 00:00\")}'::tsmultirange",
);
queryErrorParity("an unterminated multirange", [], "SELECT '{[1,2'::int4multirange", "invalid_text_representation");
queryErrorParity(
  "a range is not a multirange literal",
  [],
  "SELECT '[1,2)'::int4multirange",
  "invalid_text_representation",
);
queryErrorParity("a NULL member", [], "SELECT int4multirange(int4range(1,2), NULL)");
parityTyped(
  "multirange result types",
  [],
  "SELECT '{}'::int4multirange AS a, range_agg(int4range(1, 2)) AS b, '{[1,2)}'::nummultirange + '{[3,4)}' AS c, lower('{[1,2)}'::datemultirange) AS d",
);
sequenceParity(
  "a multirange column",
  [],
  [
    { sql: "CREATE TABLE mr (m int4multirange)" },
    { sql: "INSERT INTO mr VALUES ('{[1,2),[3,4)}'), ('{}'), (NULL)" },
    { sql: "SELECT m FROM mr ORDER BY m", query: true },
    { sql: "SELECT count(*) FROM mr WHERE m @> 3", query: true },
  ],
  { compareFinalState: true },
);

test("multirange values survive an encoded snapshot", () => {
  const db = new Database();
  db.exec("CREATE TABLE mr (m nummultirange, d datemultirange)");
  db.exec("INSERT INTO mr VALUES ('{[1.5,2),[3,4]}', '{[2024-01-01,2024-02-01)}'), ('{}', NULL)");
  const copy = Snapshot.decode(db.snapshot().encode()).open();
  expect(copy.query("SELECT m::text AS m, d::text AS d FROM mr ORDER BY m")).toEqual([
    { m: "{[1.5,2),[3,4]}", d: "{[2024-01-01,2024-02-01)}" },
    { m: "{}", d: null },
  ]);
});
