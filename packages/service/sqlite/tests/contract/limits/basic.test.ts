import { parity } from "../helpers.ts";

const data = ["CREATE TABLE t(id INTEGER)", "INSERT INTO t VALUES (1),(2),(3),(4),(5),(6)"];

parity("LIMIT truncates ordered results", data, "SELECT id FROM t ORDER BY id LIMIT 3");
parity("LIMIT with OFFSET skips rows", data, "SELECT id FROM t ORDER BY id LIMIT 2 OFFSET 2");
parity("comma LIMIT syntax treats first value as offset", data, "SELECT id FROM t ORDER BY id LIMIT 2,3");
parity("LIMIT larger than result set", data, "SELECT id FROM t ORDER BY id LIMIT 99 OFFSET 4");
parity("LIMIT zero returns no rows", data, "SELECT id FROM t ORDER BY id LIMIT 0");
