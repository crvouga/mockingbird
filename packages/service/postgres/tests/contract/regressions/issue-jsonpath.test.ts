import { expect, test } from "bun:test";
import { Database } from "../../../src/index.ts";
import { expectParity } from "../../harness/assert.ts";
import { matrixBoth } from "../../harness/matrix.ts";
import { errorParity, parity } from "../helpers.ts";

/** Every statement against one memory / oracle pair (a table of cases needs one oracle reset, not one each). */
function parityEach(name: string, statements: string[], options: Parameters<typeof expectParity>[2] = {}): void {
  matrixBoth(name, async (memory, postgres) => {
    for (const sql of statements) {
      try {
        expectParity(await memory.query(sql), await postgres.query(sql), { ignoreErrorPhase: true, ...options });
      } catch (error) {
        throw new Error(`${sql}\n${(error as Error).message}`);
      }
    }
  });
}

// #538 item 2: SQL/JSON path functions and the @? / @@ operators, checked against PostgreSQL 18

const doc = `{"a":[1,2,3],"b":{"c":"x","d":[{"e":1},{"e":2},{"e":3}]},"s":"hello","n":null,"t":true,"f":1.5,"neg":-2,"arr2":[[1,2],[3,4]],"str":["apple","banana","cherry"]}`;
const q = (path: string, vars?: string) =>
  `SELECT jsonb_path_query_array('${doc}'::jsonb, '${path}'${vars ? `, '${vars}'` : ""}) AS r`;

const paths = [
  // accessors
  "$",
  "$.a",
  "$.a[0]",
  "$.a[1 to 2]",
  "$.a[last]",
  "$.a[last - 1]",
  "$.a[*]",
  "$.a[0, 2]",
  "$.a[5]",
  "$.b.c",
  "$.b.d[*].e",
  "$.*",
  "$.b.*",
  '$."b"."c"',
  "$.missing",
  "$.a.b",
  "$.arr2[*][0]",
  "$.arr2[1][1]",
  "$.a[last to last]",
  "$.a[1 to 10]",
  "$.s[0]",
  "$.s[*]",
  "$.n",
  "$.n.x",
  "$.a.x.y",
  // filters
  "$.a[*] ? (@ > 1)",
  "$.a[*] ? (@ == 2)",
  "$.a[*] ? (@ != 2)",
  "$.a[*] ? (@ >= 2 && @ < 3)",
  "$.a[*] ? (@ < 2 || @ > 2)",
  "$.a ? (@ > 1)",
  "$.a[*] ? (!(@ > 1))",
  "$.b.d[*] ? (@.e > 1).e",
  "$.b.d ? (@.e == 2)",
  "$.b.d[*] ? (exists(@.e))",
  "$.b.d[*] ? (exists(@.zz))",
  "$.b.d[*] ? (!exists(@.zz))",
  '$.str[*] ? (@ starts with "b")',
  '$.str[*] ? (@ like_regex "^a")',
  '$.str[*] ? (@ like_regex "^A" flag "i")',
  "$.a[*] ? ((@ > 1) is unknown)",
  '$.s ? (@ == "hello")',
  '$.s ? (@ == "x")',
  "$ ? (@.t == true)",
  "$ ? (@.n == null)",
  "$ ? (@.s == 1)",
  "$ ? (@.s != 1)",
  '$.a[*] ? (@ == "1")',
  "$.a ? (@[*] > 2)",
  "$.b.d[*] ? (@.e > 1 && @.e < 3)",
  "$.b.d[*].e ? (@ > $.a[0])",
  "$.a[*] ? (@ == $.a[1])",
  "$.n ? (@ == null)",
  // arithmetic
  "$.a[0] + 1",
  "$.a[1] * 3",
  "$.a[2] - 10",
  "$.a[2] / 2",
  "$.a[2] % 2",
  "-$.a[0]",
  "+$.a[0]",
  "$.f * 2",
  "$.neg + 1",
  "$.a[*] + 1",
  "$.a[last] - $.a[0]",
  "($.a[0] + $.a[1]) * $.a[2]",
  "$.a[0] / 0",
  "$.s + 1",
  // methods
  "$.a.size()",
  "$.s.size()",
  "$.a.type()",
  "$.s.type()",
  "$.n.type()",
  "$.t.type()",
  "$.b.type()",
  "$.f.type()",
  "$.f.ceiling()",
  "$.f.floor()",
  "$.neg.abs()",
  "$.a[*].double()",
  "$.s.double()",
  '"1.5".double()',
  "$.a.abs()",
  '$.a[*] ? (@.type() == "number")',
  '$.* ? (@.type() == "string")',
  // predicates as the whole path
  "$.a[0] == 1",
  "$.a[*] > 2",
  "$.a[0] > 5",
  '$.s == "hello"',
  "exists($.a)",
  "exists($.zz)",
  "$.a[0] == 1 && $.a[1] == 2",
  "$.n == null",
  '$.s starts with "he"',
  '$.s like_regex "ll"',
  "!($.a[0] == 1)",
  "$.s > 1",
  // modes
  "lax $.a",
  "strict $.a",
  "strict $.a[0]",
  "strict $.a[5]",
  "strict $.missing",
  "lax $.missing",
  "strict $.s.x",
  "strict $.a.x",
  "strict $.a[*]",
  "strict $.s[0]",
  "lax $.s[0]",
  "lax $.a.size()",
  "strict $.s.size()",
  "strict $.a[*] ? (@ > 1)",
  "strict $.b.d[*].e",
  "strict $.b.d.e",
  "lax $.b.d.e",
  "strict $ ? (@.missing == 1)",
  "lax $ ? (@.missing == 1)",
  "strict $.a[0 to 5]",
];
parityEach(
  "#538 jsonpath accessors, filters, arithmetic, methods, predicates and modes",
  paths.map((path) => q(path)),
);

parity("#538 jsonpath variables", [], q("$.a[*] ? (@ > $min)", '{"min":1}'));
parity("#538 jsonpath string variable", [], q("$.str[*] ? (@ == $w)", '{"w":"banana"}'));
errorParity("#538 jsonpath missing variable", [], q("$.a[*] ? (@ > $min)", "{}"));
errorParity("#538 jsonpath vars must be an object", [], q("$.a", "[1]"));

for (const [label, sql] of [
  ["exists", `SELECT jsonb_path_exists('${doc}'::jsonb, '$.a[*] ? (@ > 2)') AS r`],
  ["exists is false", `SELECT jsonb_path_exists('${doc}'::jsonb, '$.a[*] ? (@ > 5)') AS r`],
  ["exists with vars", `SELECT jsonb_path_exists('${doc}'::jsonb, '$.a[*] ? (@ > $x)', '{"x":2}') AS r`],
  [
    "exists strict miss is an error, silent is NULL",
    `SELECT jsonb_path_exists('${doc}'::jsonb, 'strict $.missing', '{}', true) AS r`,
  ],
  [
    "match",
    `SELECT jsonb_path_match('${doc}'::jsonb, '$.a[0] == 1') AS r, jsonb_path_match('${doc}'::jsonb, '$.a[0] == 2') AS r2`,
  ],
  ["match unknown is NULL", `SELECT jsonb_path_match('${doc}'::jsonb, '$.s > 1') AS r`],
  ["match silent on a non-boolean", `SELECT jsonb_path_match('${doc}'::jsonb, '$.a', '{}', true) AS r`],
  [
    "query_first",
    `SELECT jsonb_path_query_first('${doc}'::jsonb, '$.a[*] ? (@ > 1)') AS r, jsonb_path_query_first('${doc}'::jsonb, '$.zz') AS z`,
  ],
  ["query rows", `SELECT * FROM jsonb_path_query('${doc}'::jsonb, '$.a[*] ? (@ > 1)')`],
  ["query rows with a column alias", `SELECT x FROM jsonb_path_query('${doc}'::jsonb, '$.b.d[*].e') AS x`],
  ["query on a predicate", `SELECT * FROM jsonb_path_query('${doc}'::jsonb, '$.a[0] == 1')`],
  ["NULL arguments", `SELECT jsonb_path_exists(NULL, '$') AS a, jsonb_path_query_array('{}'::jsonb, NULL) AS b`],
  [
    "@? operator",
    `SELECT '${doc}'::jsonb @? '$.a[*] ? (@ > 2)' AS t, '${doc}'::jsonb @? '$.a[*] ? (@ > 5)' AS f, '${doc}'::jsonb @? '$.zz' AS z`,
  ],
  [
    "@@ operator",
    `SELECT '${doc}'::jsonb @@ '$.a[0] == 1' AS t, '${doc}'::jsonb @@ '$.a[0] == 2' AS f, '${doc}'::jsonb @@ '$.s > 1' AS u`,
  ],
  [
    "@? and @@ swallow errors",
    `SELECT '${doc}'::jsonb @? 'strict $.zz' AS a, '${doc}'::jsonb @@ 'strict $.zz == 1' AS b`,
  ],
  [
    "jsonpath typed operands",
    `SELECT '${doc}'::jsonb @? '$.b.c'::jsonpath AS a, jsonb_path_exists('${doc}'::jsonb, '$.b.c'::jsonpath) AS b`,
  ],
  [
    "in a WHERE clause",
    `SELECT count(*) AS n FROM (VALUES ('{"a":1}'::jsonb), ('{"a":2}'), ('{"b":1}')) v(j) WHERE j @? '$.a ? (@ > 1)'`,
  ],
  [
    "_tz variants",
    `SELECT jsonb_path_exists_tz('${doc}'::jsonb, '$.a') AS a, jsonb_path_query_array_tz('${doc}'::jsonb, '$.a') AS b`,
  ],
] as const) {
  parity(`#538 jsonpath ${label}`, [], sql);
}

for (const [label, sql] of [
  ["strict miss", `SELECT jsonb_path_exists('${doc}'::jsonb, 'strict $.missing')`],
  ["strict out of bounds", `SELECT jsonb_path_query_array('${doc}'::jsonb, 'strict $.a[7]')`],
  ["strict member on an array", `SELECT jsonb_path_query_array('${doc}'::jsonb, 'strict $.a.x')`],
  ["arithmetic on a string", `SELECT jsonb_path_query_array('${doc}'::jsonb, '$.s + 1')`],
  ["division by zero", `SELECT jsonb_path_query_array('${doc}'::jsonb, '$.a[0] / 0')`],
  ["match on a non-boolean", `SELECT jsonb_path_match('${doc}'::jsonb, '$.a[0]')`],
  ["size on a non-array in strict mode", `SELECT jsonb_path_query_array('${doc}'::jsonb, 'strict $.s.size()')`],
  ["double on a bad string", `SELECT jsonb_path_query_array('${doc}'::jsonb, '$.s.double()')`],
  ["floor of a string", `SELECT jsonb_path_query_array('${doc}'::jsonb, '$.s.floor()')`],
  ["unary minus on a string", `SELECT jsonb_path_query_array('${doc}'::jsonb, '-$.s')`],
  ["last outside a subscript", `SELECT jsonb_path_query_array('${doc}'::jsonb, 'last')`],
  ["syntax: unbalanced bracket", `SELECT '$.a['::jsonpath`],
  ["syntax: trailing operator", `SELECT '$.a +'::jsonpath`],
  ["syntax: bad character", `SELECT '$.a # 1'::jsonpath`],
  ["syntax: not a path", `SELECT 'abc'::jsonpath`],
  ["syntax: empty", `SELECT ''::jsonpath`],
] as const) {
  errorParity(`#538 jsonpath error: ${label}`, [], sql);
}

test("#538 jsonpath features that are not modelled are refused as unsupported (0A000)", () => {
  const db = new Database();
  for (const path of ["$.**", "$.a.keyvalue()", "$.s.datetime()", "$.f.bigint()", "$.s.string()"]) {
    let state: string | undefined;
    try {
      db.query(`SELECT jsonb_path_query_array('{"a":1,"s":"x","f":1}'::jsonb, '${path}')`);
    } catch (error) {
      state = (error as { sqlState?: string }).sqlState;
    }
    expect(state, path).toBe("0A000");
  }
});

// the text output of a jsonpath is PostgreSQL's canonical spelling
const spellings = [
  "$",
  "$.a",
  "strict $.a[*]",
  "lax $.a",
  "$.a ? (@ == 1)",
  "$.a ? (@.b == 1 && (@.c > 2 || !(@.d < 3)))",
  "$.a + 1 * (2 - 3) / 4 % 5",
  "-$.a",
  "+$.a",
  "$.a[last - 1]",
  "$.a[1 to 2, 5]",
  "$.a[last]",
  "$.a[(1 + 1)]",
  '$ ? (exists(@.a) && @.b starts with "x" && @.c like_regex "y" flag "i" && (@.d > 1) is unknown)',
  "$.s.type().size()",
  "$var",
  '$"my var"',
  '$.a[*]."b c"',
  "$.*",
  "$.a ? (@ == null)",
  "1.50",
  '"a\\nb"',
  "$.a == true",
  "($.a + 1) * 2",
  "$.a + (1 * 2)",
  "$.a - (1 - 2)",
  "$.a - 1 - 2",
  "$.a ? (@ > 1) ? (@ < 3)",
  "$.a ? (!(@ > 1))",
  "$.a ? (!exists(@.x))",
  "($.a + 1).type()",
  '$.a ? (@ like_regex "^x")',
  "$.a ? ((@.x > 1) is unknown || @.y == 2)",
  "$ ? (@ > 1 && @ < 2 || @ == 3)",
  "$ ? (@ > 1 || @ < 2 && @ == 3)",
  '$."a\\"b"',
  "$.a ? (@.size() > 1)",
  "$.a ? (@ == $x + 1)",
  "exists($.a)",
  "!($.a == 1)",
  "-(1 + 2)",
  "$.a ? (-@ > 1)",
  "$.a[0].b[*][1 to 2]",
  "$.a ? (@ starts with $p)",
  "$ ? ((@ > 1))",
  "$ ? (@.a == 1 || (@.b == 2 && @.c == 3))",
  "$.a ? (@ == 1.0)",
  "1e3",
  ".5 + 1",
  '$.a ? (@ == "x\\u0041")',
];
parityEach(
  "#538 jsonpath output spelling",
  spellings.map((path) => `SELECT '${path.replaceAll("'", "''")}'::jsonpath::text AS r`),
);
parity(
  "#538 a jsonpath survives a round trip through its own output",
  [],
  `SELECT ('$.a ? (@ > 1)'::jsonpath::text)::jsonpath::text AS r`,
);
