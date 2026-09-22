import { parity, queryErrorParity } from "../helpers.ts";

const emp = [
  "CREATE TABLE emp (id int, name text, dept text, salary int)",
  "INSERT INTO emp VALUES (1, 'a', 'eng', 100), (2, 'b', 'eng', 120), (3, 'c', 'ops', 90), (4, 'd', 'ops', 95)",
];

parity(
  "greater than department average",
  emp,
  "SELECT name FROM emp e WHERE salary > (SELECT avg(salary) FROM emp i WHERE i.dept = e.dept) ORDER BY name",
);
parity(
  "correlated count in select list",
  emp,
  "SELECT dept, (SELECT count(*) FROM emp i WHERE i.dept = e.dept) AS dept_size FROM emp e ORDER BY e.id",
);
parity(
  "correlated subquery referencing outer alias",
  emp,
  "SELECT e.name FROM emp e WHERE e.salary = (SELECT max(i.salary) FROM emp i WHERE i.dept = e.dept) ORDER BY e.name",
);
parity(
  "correlated subquery in case expression",
  emp,
  "SELECT name, CASE WHEN salary >= (SELECT max(salary) FROM emp i WHERE i.dept = e.dept) THEN 'top' ELSE 'other' END AS tier FROM emp e ORDER BY name",
);
parity(
  "correlation through two levels",
  emp,
  "SELECT name FROM emp e WHERE EXISTS (SELECT 1 FROM emp m WHERE m.dept = e.dept AND m.salary > (SELECT avg(salary) FROM emp i WHERE i.dept = e.dept)) ORDER BY name",
);
parity(
  "correlated with outer column arithmetic",
  ["CREATE TABLE t (id int, v int)", "INSERT INTO t VALUES (1, 5), (2, 10), (3, 20)"],
  "SELECT id FROM t o WHERE EXISTS (SELECT 1 FROM t i WHERE i.v = o.v * 2) ORDER BY id",
);
parity(
  "correlated subquery in having",
  emp,
  "SELECT dept, count(*) AS n FROM emp e GROUP BY dept HAVING count(*) > (SELECT count(*) FROM emp i WHERE i.dept = 'nowhere') ORDER BY dept",
);
parity(
  "correlated update-style anti join",
  [
    "CREATE TABLE a (id int)",
    "CREATE TABLE b (id int)",
    "INSERT INTO a VALUES (1), (2), (3)",
    "INSERT INTO b VALUES (2)",
  ],
  "SELECT id FROM a WHERE NOT EXISTS (SELECT 1 FROM b WHERE b.id = a.id) ORDER BY id",
);

// errors
queryErrorParity(
  "aggregate of outer column mixed with inner ungrouped",
  emp,
  "SELECT (SELECT sum(e.salary + i.salary) FROM emp i GROUP BY i.dept) FROM emp e",
  undefined,
);
