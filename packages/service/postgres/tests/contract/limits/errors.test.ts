import { parity, queryErrorParity } from "../helpers.ts";

const t = ["CREATE TABLE t (id int)", "INSERT INTO t VALUES (1), (2), (3)"];

queryErrorParity("negative limit", t, "SELECT id FROM t ORDER BY id LIMIT -1", "data_exception");
queryErrorParity("negative offset", t, "SELECT id FROM t ORDER BY id OFFSET -1", "data_exception");
queryErrorParity("negative fetch count", t, "SELECT id FROM t ORDER BY id FETCH FIRST -2 ROWS ONLY", undefined);
queryErrorParity("limit non-integer text", t, "SELECT id FROM t ORDER BY id LIMIT 'x'", undefined);
queryErrorParity("with ties requires order by", t, "SELECT id FROM t FETCH FIRST 1 ROW WITH TIES", "syntax");

// boundary behaviors that succeed
parity("limit numeric value truncates", t, "SELECT id FROM t ORDER BY id LIMIT 2.4");
parity("limit numeric rounds half up", t, "SELECT id FROM t ORDER BY id LIMIT 1.5");
parity("offset null means zero", t, "SELECT id FROM t ORDER BY id OFFSET NULL");
