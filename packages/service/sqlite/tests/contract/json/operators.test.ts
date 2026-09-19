import { parity } from "../helpers.ts";

const DOC = `'{"a":2,"c":[4,5,{"f":7}]}'`;

parity("arrow -> array", [], `SELECT ${DOC} -> '$.c'`);
parity("arrow -> object field shorthand", [], `SELECT ${DOC} -> 'c'`);
parity("arrow -> nested", [], `SELECT ${DOC} -> '$.c[2]'`);
parity("arrow -> scalar as json text", [], `SELECT ${DOC} -> '$.c[2].f'`);
parity("arrow ->> scalar as sql", [], `SELECT ${DOC} ->> '$.c[2].f'`);
parity("arrow -> string keeps quotes", [], `SELECT '{"a":"xyz"}' -> '$.a'`);
parity("arrow ->> string dequotes", [], `SELECT '{"a":"xyz"}' ->> '$.a'`);
parity("arrow -> json null", [], `SELECT '{"a":null}' -> '$.a'`);
parity("arrow ->> json null", [], `SELECT '{"a":null}' ->> '$.a'`);
parity("arrow array index", [], `SELECT '[11,22,33,44]' -> 3`);
parity("arrow ->> array index", [], `SELECT '[11,22,33,44]' ->> 3`);
parity("arrow chain", [], `SELECT ${DOC} -> 'c' -> 2 ->> 'f'`);
parity("arrow subtype", [], `SELECT subtype(${DOC} -> '$.a')`);
