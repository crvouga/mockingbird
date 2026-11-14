import { expectParity } from "../../harness/assert.ts";
import { matrixBoth } from "../../harness/matrix.ts";

/** Every statement against one memory / oracle pair: rows, column names, SQLSTATEs and messages must match. */
function parityEach(name: string, statements: string[]): void {
  matrixBoth(name, async (memory, postgres) => {
    for (const sql of statements) {
      try {
        expectParity(await memory.query(sql), await postgres.query(sql), {
          ignoreErrorPhase: true,
          ignoreWriteCounters: true,
        });
      } catch (error) {
        throw new Error(`${sql}\n${(error as Error).message}`);
      }
    }
  });
}

// #723 item 1: jsonb_exists / jsonb_exists_any / jsonb_exists_all, the functions behind ? ?| ?&

parityEach("#723 jsonb_exists family", [
  `select jsonb_exists('{"a":1}', 'a'), jsonb_exists('{"a":1}', 'b'), jsonb_exists('["a","b"]', 'a'), jsonb_exists('"a"', 'a'), jsonb_exists('1', 'a')`,
  `select jsonb_exists(null, 'a'), jsonb_exists('{"a":1}', null), pg_typeof(jsonb_exists('{}', 'a'))`,
  `select jsonb_exists('{"a":{"b":1}}', 'b'), jsonb_exists('[["a"]]', 'a'), jsonb_exists('{"a":1}'::jsonb, 'a'::text)`,
  `select jsonb_exists_any('{"a":1}', array['b','a']), jsonb_exists_any('{"a":1}', '{b,c}'), jsonb_exists_any('{"a":1}', '{}'), jsonb_exists_any('{"a":1}', array[null,'a'])`,
  `select jsonb_exists_all('{"a":1,"b":2}', array['b','a']), jsonb_exists_all('{"a":1}', '{a,c}'), jsonb_exists_all('{"a":1}', '{}'), jsonb_exists_all('{"a":1}', array[null,'a'])`,
  `select jsonb_exists_any('["x","y"]', '{y}'), jsonb_exists_all('["x","y"]', '{x,y}'), jsonb_exists_any(null, '{a}'), jsonb_exists_all('{}', null)`,
  `select pg_typeof(jsonb_exists_any('{}', '{}')), pg_typeof(jsonb_exists_all('{}', '{}'))`,
  `select k, jsonb_exists('{"a":1,"bb":2}', k) from (values ('a'), ('bb'), ('c')) v(k)`,
  // the same answers as the operators
  `select '{"a":1,"b":2}'::jsonb ? 'a' = jsonb_exists('{"a":1,"b":2}', 'a'), '{"a":1}'::jsonb ?| '{b}' = jsonb_exists_any('{"a":1}', '{b}')`,
  // json (not jsonb) has no implicit cast: no such function
  `select jsonb_exists('{"a":1}'::json, 'a')`,
  `select jsonb_exists_any('{"a":1}'::json, '{a}')`,
  `select jsonb_exists('{"a":1}', 1)`,
]);

// #723 item 2: the jsonpath `.**` recursive wildcard and its level forms

const tree = `{"a":{"k":1,"b":[{"k":2}]}}`;
const nested = `[1,[2,[3]],{"x":[4]}]`;
const qa = (doc: string, path: string) => `select jsonb_path_query_array('${doc}', '${path}')`;

parityEach("#723 jsonpath .** on an object", [
  qa(tree, "$.**"),
  qa(tree, "lax $.**"),
  qa(tree, "strict $.**"),
  qa(tree, "lax $.**{2}"),
  qa(tree, "strict $.**.k"),
  qa(tree, "lax $.**.k"),
  qa(`{"a":{"k":1}}`, "$.**.k"),
  qa(tree, "$.**{0}"),
  qa(tree, "$.**{1}"),
  qa(tree, "$.**{1 to last}"),
  qa(tree, "$.**{last}"),
  qa(tree, "strict $.**{last}"),
  qa(tree, "$.**{1 to 2}"),
  qa(tree, "$.**{2 to 1}"),
  qa(tree, "$.**{last to 2}"),
  qa(tree, "$.**{2 to last}"),
  qa(tree, "$.**{0 to last}"),
  qa(tree, "$.** {3}"),
  qa(`{"b":1,"aa":2,"a":{"c":3}}`, "$.**"),
  qa("{}", "$.**"),
  qa("5", "$.**"),
  qa("5", "$.**{1}"),
  qa("5", "$.**{last}"),
  qa(`{"a":[{"b":1},{"b":[2]}]}`, "strict $.a.**.b"),
  qa(`{"a":[{"b":1},{"b":[2]}]}`, "lax $.a.**.b"),
  qa(`{"a":[{"b":1},{"b":[2]}]}`, "strict $.a.**{2}.b"),
]);

parityEach("#723 jsonpath .** on arrays", [
  qa(nested, "$.**"),
  qa(nested, "strict $.**"),
  qa(nested, "$.**{1}"),
  qa(nested, "$.**{last}"),
  qa(nested, "lax $.**[*]"),
  qa(nested, "strict $.**[*]"),
  qa(nested, "strict $.**[0]"),
  qa(nested, "lax $.**[0]"),
  qa(nested, "strict $.**[1 to 5]"),
  qa(nested, "lax $.**.x"),
  qa(nested, "strict $.**.x"),
  qa(nested, "strict $.**.*"),
  qa(nested, "lax $.**.*"),
  qa(nested, "strict $.**.size()"),
  qa(nested, "lax $.**.size()"),
  qa(nested, "strict $.**.type()"),
  qa(nested, "strict $.**.double()"),
  qa(nested, "strict $.** ? (@ > 1)"),
  qa(nested, "lax $.** ? (@ > 1)"),
  qa(nested, "strict $.** ? (@.x == 4)"),
  qa(nested, 'lax $.** ? (@.type() == "array")'),
  qa(`{"a":[1,2]}`, "strict $.**[5]"),
  qa(`{"a":[1,2]}`, "strict $.a[5].**"),
  qa(`{"a":{"k":1}}`, "strict $.**.k.z"),
  qa(`{"a":{"k":"x"}}`, "strict $.**.k + 1"),
  qa(`{"a":{"k":1}}`, "strict $.**.k + 1"),
  qa(`{"a":{"k":1}}`, "strict -$.**.k"),
]);

parityEach("#723 jsonpath .** through every entry point", [
  `select jsonb_path_query('${tree}', '$.**.k')`,
  `select jsonb_path_query('${tree}', 'strict $.**')`,
  `select jsonb_path_exists('${tree}', '$.**.k ? (@ == 2)')`,
  `select jsonb_path_exists('${tree}', 'strict $.**.z')`,
  `select jsonb_path_exists('${tree}', 'strict $.**.k.z')`,
  `select jsonb_path_match('${tree}', 'exists($.**.k ? (@ == 2))')`,
  `select jsonb_path_match('${tree}', '$.**.k == 2')`,
  `select jsonb_path_query_first('${tree}', '$.**.k')`,
  `select jsonb_path_query_first('${tree}', '$.**{2}')`,
  `select '${tree}'::jsonb @? '$.** ? (@ == 2)', '${tree}'::jsonb @? '$.** ? (@ == 9)'`,
  `select '${tree}'::jsonb @@ '$.**.k == 2'`,
  `select jsonb_path_query_array('${tree}', '$.** ? (@.k == $v)', '{"v":2}')`,
  `select jsonb_path_query_array('[{"a":[{"a":1}]}]', '$.**.a')`,
  `select jsonb_path_query_array('[{"a":[{"a":1}]}]', 'strict $.**.a')`,
  // a predicate path always has a result, unknown included, so it exists
  `select jsonb_path_exists('{"a":"x"}', '$.a > 5'), jsonb_path_exists('{"a":1}', '$.a > 5'), jsonb_path_exists('{"a":"x"}', 'strict $.a > 5')`,
  `select '{"a":"x"}'::jsonb @? '$.a > 5', jsonb_path_exists('{"a":"x"}', '$.a > 5', '{}', true)`,
  `select jsonb_path_exists('{"a":"x"}', '$.a[1/0] > 5', '{}', true), jsonb_path_exists('{"a":"x"}', '1/0', '{}', true)`,
]);

parityEach("#723 jsonpath .** text form and syntax errors", [
  `select '$.**'::jsonpath, '$.**{2}'::jsonpath, '$.**{1 to last}'::jsonpath, '$.**{last}'::jsonpath, '$.**{0 to last}'::jsonpath`,
  `select '$.**{2 to 2}'::jsonpath, '$.**{last to 3}'::jsonpath, '$.**{1 to 3}'::jsonpath, 'strict $.**.a'::jsonpath`,
  `select '$.a.**.b[*]'::jsonpath, '$ ? (@.** == 1)'::jsonpath, '$.** {2}'::jsonpath, '$.**{last to last}'::jsonpath`,
  `select '$.**{-1}'::jsonpath`,
  `select '$.**{1.5}'::jsonpath`,
  `select '$.**{}'::jsonpath`,
  `select '$.* *'::jsonpath`,
  `select '$**'::jsonpath`,
  `select '$.**{1 to}'::jsonpath`,
  `select '$.**{a}'::jsonpath`,
  `select '$.**{2147483647}'::jsonpath`,
  `select '$.**{2147483648}'::jsonpath`,
]);

// #723 item 3: jsonb_object / json_object with untyped literals, 2-D arrays and their errors

parityEach("#723 json[b]_object from text arrays", [
  `select jsonb_object('{a,1,b,2}'), json_object('{a,1,b,2}')`,
  `select jsonb_object('{{a,1},{b,2}}'), json_object('{{a,1},{b,2}}')`,
  `select jsonb_object('{a,b}', '{1,2}'), json_object('{a,b}', '{1,2}')`,
  `select jsonb_object('{}'), json_object('{}'), jsonb_object('{}', '{}'), json_object('{}', '{}')`,
  `select jsonb_object('{a,NULL}'), jsonb_object('{a,b}', '{1,NULL}'), json_object('{a,NULL}')`,
  `select jsonb_object('{a,1,a,2}'), json_object('{a,1,a,2}')`,
  `select jsonb_object(array['a','1']), jsonb_object(array[['a','1'],['b','2']]), json_object(array['k'], array['v'])`,
  `select pg_typeof(jsonb_object('{a,1}')), pg_typeof(json_object('{a,1}'))`,
  `select jsonb_object('{a,1,b}')`,
  `select json_object('{a,1,b}')`,
  `select json_object('{a,1,b}'::text[])`,
  `select jsonb_object('{{a,1,c},{b,2,d}}')`,
  `select json_object('{{a},{b}}')`,
  `select jsonb_object('{{{a,b}}}')`,
  `select jsonb_object('{a,b}', '{1}')`,
  `select json_object('{a}', '{1,2}')`,
  `select jsonb_object('{NULL,a}')`,
  `select jsonb_object('{{NULL,a}}')`,
  `select jsonb_object('{NULL}', '{a}')`,
  `select jsonb_object('{{a,b}}', '{{1,2}}')`,
  `select jsonb_object('{a,b}', '{}')`,
  `select jsonb_object(null::text[]), jsonb_object('{a}', null)`,
]);

// #723 item 4 / #728: SQL/JSON IS JSON predicates

parityEach("#728 IS JSON predicates", [
  `select '{"a":1}' is json, '{"a":1}' is not json, 'abc' is json, '[1]' is json object, '[1]' is json array, '1' is json scalar`,
  `select '{}' is json object, '"x"' is json scalar, 'null' is json scalar, '{"a":1}'::text is json value, ' 1 ' is json, '' is json`,
  `select '{"a":1,"a":2}' is json with unique keys, '{"a":1,"a":2}' is json without unique keys, '{"a":1,"a":2}' is json object with unique keys`,
  `select '{"a":1,"a":2}' is json with unique, '[{"a":1,"a":2}]' is json with unique keys, '{"a":{"b":1,"b":2}}' is json with unique keys`,
  `select '{"a":1,"b":{"a":2}}' is json with unique keys, '[1,2]' is json array with unique keys, '{"a":1,"a":2}' is not json with unique keys`,
  `select '{"a":1,"a":2}'::json is json with unique keys, '{"a":1,"a":2}'::jsonb is json with unique keys, '1'::jsonb is json scalar, '{}'::jsonb is json array`,
  `select null::text is json, null is json, null is not json, null::jsonb is json object`,
  `select '1'::bytea is json, '{"a":1}'::varchar is json object, '{"a":1}'::json is not json array, '1'::char(3) is json, '{"a":1}'::name is json`,
  `select x, x is json, x is json object, x is not json scalar, x is json array from (values ('1'), ('{}'), ('[]'), ('x'), (null), ('"s"')) v(x)`,
  `select ('1' is json) is true, not '1' is json, '1' is json and true, pg_typeof('1' is json)`,
  `select '{"a":1}' is json, 1`,
  `select '{"a":"\\u0000"}' is json, '{"\\u0061":1,"a":2}' is json with unique keys, '[1,]' is json, '{"a" 1}' is json`,
  `select 1 is json`,
  `select '{"a":1}' is json format json`,
]);

parityEach("#728 IS JSON in constraints and views", [
  `create table tj (j text, b jsonb, c json, check (j is json), check (j is not json array with unique keys), check (b is json scalar), check (c is json without unique keys and j is json value))`,
  `select pg_get_constraintdef(oid) as d from pg_constraint where conrelid = 'tj'::regclass order by d`,
  `insert into tj (j) values ('x')`,
  `insert into tj (j) values ('[{"a":1,"a":2}]')`,
  `insert into tj (j, b) values ('{}', '{}')`,
  `insert into tj (j, b, c) values ('{}', '1', '{"a":1,"a":2}') returning j, b, c`,
  `create view vj as select j is json as a, not j is json object as b, ('x' is json) is true as c, j is json with unique as d from tj`,
  `select pg_get_viewdef('vj')`,
  `select * from vj`,
]);

// #728: JSON_VALUE / JSON_QUERY / JSON_EXISTS

parityEach("#728 JSON_VALUE", [
  `select json_value('{"a":1}', '$.a'), pg_typeof(json_value('{"a":1}', '$.a'))`,
  `select json_value('{"a":"x"}', '$.a'), json_value('{"a":true}', '$.a'), json_value('{"a":null}', '$.a'), json_value('{"a":1.50}', '$.a')`,
  `select json_value('{"a":[1]}', '$.a'), json_value('{"a":1}', '$.b'), json_value('{"a":1}', 'strict $.b'), json_value('{"a":[1,2]}', '$.a[*]')`,
  `select json_value('{"a":[1]}', '$.a' error on error)`,
  `select json_value('{"a":[1,2]}', '$.a[*]' error on error)`,
  `select json_value('{"a":1}', '$.b' error on empty)`,
  `select json_value('{"a":1}', 'strict $.b' error on error)`,
  `select json_value('{"a":1}', '$.b' error on empty null on error)`,
  `select json_value('{"a":1}', 'strict $.b' default 'd' on error), json_value('{"a":1}', '$.b' default 'd' on empty), json_value('{"a":1}', '$.b' default 5 on empty)`,
  `select json_value('{"a":1}', '$.a' returning int), pg_typeof(json_value('{"a":1}', '$.a' returning int))`,
  `select json_value('{"a":"x"}', '$.a' returning int), json_value('{"a":"x"}', '$.a' returning int default -1 on error)`,
  `select json_value('{"a":"x"}', '$.a' returning int error on error)`,
  `select json_value('{"a":"2020-01-02"}', '$.a' returning date), json_value('{"a":1}', '$.a' returning numeric(5,2)), json_value('{"a":"abcdef"}', '$.a' returning varchar(3))`,
  `select json_value('{"a":1}', '$.a' returning json), json_value('{"a":1}', '$.a' returning jsonb), json_value('{"a":"x"}', '$.a' returning jsonb), pg_typeof(json_value('{"a":1}', '$.a' returning jsonb))`,
  `select json_value('{"a":1}', '$.a' returning bool), json_value('{"a":true}', '$.a' returning bool), json_value('{"a":true}', '$.a' returning int)`,
  `select json_value('{"a":1}'::jsonb, '$.a'), json_value('{"a":1}'::json, '$.a'), json_value('{"a":1}'::text, '$.a'), json_value('{"a":1}' format json, '$.a')`,
  `select json_value('{"a":1}', '$.a' || ''), json_value('{"a":1}', '$.' || 'a')`,
  `select json_value('{"a":1}', '$ ? (@.a == $x).a' passing 1 as x), json_value('{"a":[1,2]}', '$.a[$i]' passing 1 as i)`,
  `select json_value('{"a":1}', '$ ? (@.a == $v.x).a' passing '{"x":1}'::jsonb as v), json_value('{"a":1}', '$ ? (@.a == $v).a' passing '1'::text as v)`,
  `select json_value('{"a":"1"}', '$ ? (@.a == $v).a' passing '1'::text as v), json_value('{"a":1}', '$.a ? (@ == $v)' passing true as v)`,
  `select json_value('{"a":1}', '$.b' null on empty), json_value(null, '$.a'), json_value('{"a":1}', null)`,
  `select json_value('{"a":1}', '$.a' returning text error on empty error on error)`,
  `select json_value(x, '$.a') from (values ('{"a":1}'::jsonb), ('{"a":"s"}'), (null)) v(x)`,
  `select json_value('{"a":1.5}', '$.a' returning int), json_value('{"a":1e2}', '$.a'), json_value('{"a":1e2}', '$.a' returning float8)`,
  `select json_value('{"a":"x"}', '$.a' returning name), json_value('{"a":"  1 "}', '$.a' returning int), json_value('{"a":false}', '$.a' returning text)`,
  `select json_value('"abc"', '$' returning char(5)), json_value('"abc"', '$' returning char(2)), json_value('"abc"', '$' returning bytea)`,
  `select json_value('100000', '$' returning int2), json_value('{"a":"{1,2}"}', '$.a' returning int[]), json_value('{"a":[1,2]}', '$.a' returning int[])`,
  `select json_value('{"a":1}', '$.a' returning int) + 1`,
  `select json_value('bad', '$.a')`,
  `select json_value(1, '$.a')`,
  `select json_value('{"a":1}', '$ ? (@.a == $missing).a')`,
  `select json_value('{"a":1}', '$.a' returning int default 'x'::text on error)`,
  `select json_value('{"a":"x"}', '$.a' returning int default 'z' on error)`,
  `select json_value('{"a":1}', '$.b' returning int default 'z' on empty null on error)`,
  `select json_value('{"a":1}', '$.a' empty on error)`,
  `select json_value('{"a":1}', '$.b' empty array on empty)`,
  `select json_value('{"a":1}', '$.a' returning text format json)`,
  `select json_value('{"a":1}', '$.a' error on error error on empty)`,
  `select json_value('{"a":1}', '$.a' returning int with wrapper)`,
  `select json_value('{"a":"x"}', '$.a' returning int default (select 1) on error)`,
  `select json_value(t.j, '$.a' default t.d on empty) from (values ('{}'::jsonb, 'dd')) t(j,d)`,
  `select json_value('{"a":1}', '$.a ++')`,
  `select json_value('{"a":1}', '$.a' error)`,
  `select json_value('{"a":1}')`,
  `select json_value('{"a":1}', '$.a' as foo)`,
  `select json_value('{"a":1}', '$.a' returning int default 1/0 on error)`,
  `select json_value('{"a":"x"}', '$.a' returning int default 1/0 on error)`,
  `select json_value('{"a":1}', '$.a' returning int default 1 on empty default 2 on error), json_value('{"a":1}', 'strict $.b' returning int default 1 on empty default 2 on error)`,
  `select json_value('{"a":1}', '$.**' returning int), json_value('{"a":1}', '$.a' passing 1 as x, 2 as x), json_value('{"a":1}', '$.a ? (@ == $"X")' passing 1 as "X")`,
  `select json_value('{"a":1}', '$.a')::int, json_query('{"a":1}', '$.a')::text, json_exists('{}', '$') as e`,
  `select pg_typeof(json_value('{"a":1}', '$.a' returning numeric(5,2))), pg_typeof(json_query('[1]', '$' returning int[])), pg_typeof(json_value('1', '$' returning varchar(3)))`,
  `select json_value(jsonb '"\\u00e9"', '$'), json_query(jsonb '"a\\"b"', '$'), json_query(jsonb '"a\\"b"', '$' omit quotes returning text)`,
]);

parityEach("#728 JSON_QUERY", [
  `select json_query('{"a":[1,2]}', '$.a'), pg_typeof(json_query('{"a":[1,2]}', '$.a')), json_query('{"a":[1,2]}', '$.a[*]')`,
  `select json_query('{"a":[1,2]}', '$.a[*]' error on error)`,
  `select json_query('{"a":[1,2]}', '$.a[*]' with wrapper), json_query('{"a":[1,2]}', '$.a[*]' with array wrapper), json_query('{"a":[1,2]}', '$.a[*]' with unconditional wrapper), json_query('{"a":[1,2]}', '$.a[*]' with conditional wrapper)`,
  `select json_query('{"a":[1,2]}', '$.a' with conditional wrapper), json_query('{"a":[1,2]}', '$.a' with unconditional wrapper), json_query('{"a":1}', '$.a' with conditional wrapper), json_query('{"a":1}', '$.a' without wrapper)`,
  `select json_query('{"a":"x"}', '$.a'), json_query('{"a":"x"}', '$.a' keep quotes), json_query('{"a":"x"}', '$.a' omit quotes), json_query('{"a":"x"}', '$.a' omit quotes on scalar string)`,
  `select json_query('{"a":"x"}', '$.a' returning text), json_query('{"a":"x"}', '$.a' returning text omit quotes), json_query('{"a":"x"}', '$.a' returning text keep quotes on scalar string)`,
  `select json_query('{"a":[1,2]}', '$.a' returning json), json_query('{"a":[1,2]}', '$.a' returning text), pg_typeof(json_query('{"a":[1,2]}', '$.a' returning json))`,
  `select json_query('{"a":1}', '$.b'), json_query('{"a":1}', '$.b' empty on empty), json_query('{"a":1}', '$.b' empty array on empty), json_query('{"a":1}', '$.b' empty object on empty)`,
  `select json_query('{"a":1}', 'strict $.b' empty on error), json_query('{"a":1}', 'strict $.b' empty object on error), json_query('{"a":1}', 'strict $.b')`,
  `select json_query('{"a":1}', '$.b' with wrapper), json_query('{"a":1}', '$.b' with conditional wrapper)`,
  `select json_query('{"a":1}', '$.b' error on empty)`,
  `select json_query('{"a":1}', 'strict $.b' error on error)`,
  `select json_query('{"a":1}', '$.b' default '"d"' on empty), json_query('{"a":1}', '$.b' default '[1]'::jsonb on empty)`,
  `select json_query('{"a":1}', '$.a' returning int), json_query('{"a":"5"}', '$.a' returning int omit quotes), json_query('{"a":"5"}', '$.a' returning int)`,
  `select json_query('{"a":1}', '$.a' returning bytea), json_query('"abc"', '$' returning bytea), json_query('"abc"', '$' returning bytea omit quotes)`,
  `select json_query('{"a":{"b":1}}', '$.a' returning text), json_query('{"a":"x"}', '$.a' returning varchar(2)), json_query('{"a":1}', '$.a' returning varchar(1) error on error)`,
  `select json_query('{"a":"x"}', '$.a' returning jsonb omit quotes), json_query('{"a":"[1]"}', '$.a' returning jsonb omit quotes), json_query('{"a":1}', '$' returning varchar)`,
  `select json_query('{"a":1}', '$.a' with wrapper keep quotes), json_query('[1,2]', '$[*] ? (@ > $x)' passing 1 as x with wrapper)`,
  `select json_query('{"a":1}', '$.a' returning json format json), json_query('{"a":1}', '$.a' returning jsonb format json), json_query(jsonb '{"a":[1,2]}', 'lax $.a[*] ? (@ > 1)')`,
  `select json_query('[1,2]', '$' returning int[]), json_query('[[1,2],[3,4]]', '$' returning int[]), json_query('[1,"x"]', '$' returning int[])`,
  `select json_query('"{1,2}"', '$' returning int[] omit quotes), json_query('"{1,2}"', '$' returning int[]), json_query('{"a":1}', '$' returning int[])`,
  `select json_query('[1,"x"]', '$' returning int[] error on error)`,
  `select json_query('{"a":[1,2]}', '$.a' with wrapper omit quotes)`,
  `select json_query('{"a":1}', '$.a' true on error)`,
  `select json_query('{"a":1}', '$.a' omit quotes returning text)`,
  `select json_query('{"a":"x"}', '$.a' without wrapper omit quotes), json_query('{"a":"x"}', '$.a' without array wrapper), json_query('{"a":"x"}', '$.a' with conditional array wrapper)`,
  `select json_query('{"a":{"b":1}}', '$.**' with wrapper), json_query('{"a":1}', '$') is json object, json_query('{"a":1}', '$' with wrapper keep quotes on scalar string)`,
]);

parityEach("#728 SQL/JSON over table rows", [
  `create temp table docs (id int, j jsonb, t text)`,
  `insert into docs values (1, '{"a":1,"b":[1,2]}', '{"a":1}'), (2, '{"a":"x"}', '[1,2]'), (3, null, 'nope'), (4, '{"b":[]}', null)`,
  `select id, json_value(j, '$.a'), json_query(j, '$.b'), json_exists(j, '$.b[1]'), t is json, t is json object from docs order by id`,
  `select id from docs where json_exists(j, '$.a') and t is json order by id`,
  // (not over the NULL row: PostgreSQL 18.3 carries the previous row's ON ERROR result into a NULL context)
  `select id, json_value(j, '$.a' returning int default -1 on error) from docs where j is not null order by id`,
  `select json_value(t, '$.a' returning int) from docs where id = 3`,
]);

parityEach("#728 JSON_EXISTS", [
  `select json_exists('{"a":1}', '$.a'), json_exists('{"a":1}', '$.b'), pg_typeof(json_exists('{"a":1}', '$.a'))`,
  `select json_exists('{"a":1}', 'strict $.b'), json_exists('{"a":1}', 'strict $.b' true on error), json_exists('{"a":1}', 'strict $.b' unknown on error), json_exists('{"a":1}', 'strict $.b' false on error)`,
  `select json_exists('{"a":1}', '$ ? (@.a == $x)' passing 1 as x), json_exists('{"a":1}', '$ ? (@.a == $x)' passing 2 as x), json_exists('{"a":1}', '$.a > 0')`,
  `select json_exists(null, '$.a'), json_exists('[1,2]', 'strict $[5]'), json_exists('[1,2]', 'lax $[5]'), json_exists('{"a":"x"}', '$.a > 5')`,
  `select x, json_exists(x, '$.a') from (values ('{"a":1}'::jsonb), ('{}'), ('[{"a":1}]')) v(x)`,
  `select json_exists('{"a":1}', 'strict $.b' error on error)`,
  `select json_exists('{"a":1}', '$.a' returning int)`,
  `select json_exists('{"a":1}', '$.b' empty on error)`,
  `select json_exists('{"a":1}', '$.a' null on error)`,
  `select json_exists('{"a":1}', '$.b' false on empty)`,
]);
