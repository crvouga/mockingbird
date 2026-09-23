import { parity, queryErrorParity } from "../helpers.ts";

const values = [
  "CREATE TABLE t(id INTEGER PRIMARY KEY,g TEXT,v INTEGER)",
  "INSERT INTO t VALUES (1,'a',10),(2,'a',10),(3,'a',20),(4,'a',30),(5,'b',5)",
];

parity(
  "GROUPS frame offsets count peer groups",
  values,
  "SELECT id,sum(v) OVER (PARTITION BY g ORDER BY v GROUPS BETWEEN 1 PRECEDING AND 1 FOLLOWING) AS total FROM t ORDER BY id",
);

parity(
  "RANGE frame uses numeric ORDER BY offsets",
  values,
  "SELECT id,sum(v) OVER (PARTITION BY g ORDER BY v RANGE BETWEEN 5 PRECEDING AND 10 FOLLOWING) AS total FROM t ORDER BY id",
);

parity(
  "window aggregate FILTER excludes rows inside its frame",
  values,
  "SELECT id,sum(v) FILTER (WHERE id%2=1) OVER (PARTITION BY g ORDER BY id ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS odd_total FROM t ORDER BY id",
);

parity(
  "lag and lead accept offset and default",
  values,
  "SELECT id,lag(v,2,-1) OVER (PARTITION BY g ORDER BY id) AS prev,lead(v,2,-1) OVER (PARTITION BY g ORDER BY id) AS next FROM t ORDER BY id",
);

parity(
  "empty OVER applies a window to the whole result",
  values,
  "SELECT id,row_number() OVER () AS rn,sum(v) OVER () AS total FROM t ORDER BY id",
);

parity(
  "nth_value picks the n-th row in the frame",
  values,
  "SELECT id,nth_value(v,2) OVER (PARTITION BY g ORDER BY id ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING) AS n2 FROM t ORDER BY id",
);

parity(
  "ROWS BETWEEN CURRENT ROW AND UNBOUNDED FOLLOWING",
  values,
  "SELECT id,sum(v) OVER (PARTITION BY g ORDER BY id ROWS BETWEEN CURRENT ROW AND UNBOUNDED FOLLOWING) AS tail FROM t ORDER BY id",
);

queryErrorParity(
  "window function in WHERE is misuse",
  ["CREATE TABLE t(id INTEGER)", "INSERT INTO t VALUES (1)"],
  "SELECT id FROM t WHERE row_number() OVER (ORDER BY id) = 1",
  "misuse",
);

queryErrorParity(
  "IGNORE NULLS is a syntax error on SQLite 3.51",
  values,
  "SELECT id, first_value(v) IGNORE NULLS OVER (ORDER BY id) AS f FROM t ORDER BY id",
  "syntax",
);

queryErrorParity(
  "RESPECT NULLS is a syntax error on SQLite 3.51",
  values,
  "SELECT id, first_value(v) RESPECT NULLS OVER (ORDER BY id) AS f FROM t ORDER BY id",
  "syntax",
);
