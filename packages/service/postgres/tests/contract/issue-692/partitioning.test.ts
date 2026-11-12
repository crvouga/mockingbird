import { expect, test } from "bun:test";
import { Database, Snapshot } from "../../../src/index.ts";
import { errorParity, parity, sequenceParity } from "../helpers.ts";

// #692: declarative partitioning — RANGE / LIST / HASH, DEFAULT, routing, ATTACH / DETACH, catalogs.

const q = (sql: string) => ({ sql, query: true });
const range = [
  "CREATE TABLE p (d date, v int) PARTITION BY RANGE (d)",
  "CREATE TABLE p1 PARTITION OF p FOR VALUES FROM ('2024-01-01') TO ('2024-02-01')",
  "CREATE TABLE p2 PARTITION OF p FOR VALUES FROM ('2024-02-01') TO ('2024-03-01')",
  "INSERT INTO p VALUES ('2024-01-05', 1), ('2024-02-10', 2)",
];

parity(
  "rows land in their partitions; the parent sees them all",
  range,
  "SELECT tableoid::regclass AS part, * FROM p ORDER BY d",
);
parity("a partition sees only its own rows", range, "SELECT * FROM p1 UNION ALL SELECT * FROM p2 ORDER BY 1");
errorParity("a row no partition takes", range, "INSERT INTO p VALUES ('2024-05-01', 3)", "constraint_check");
errorParity(
  "a row outside a partition inserted into it",
  range,
  "INSERT INTO p1 VALUES ('2024-02-10', 9)",
  "constraint_check",
);
errorParity(
  "overlapping range partitions",
  range,
  "CREATE TABLE p3 PARTITION OF p FOR VALUES FROM ('2024-02-15') TO ('2024-04-01')",
);
errorParity(
  "an empty range bound",
  range,
  "CREATE TABLE p3 PARTITION OF p FOR VALUES FROM ('2024-05-01') TO ('2024-04-01')",
);
sequenceParity(
  "a DEFAULT partition, UPDATE moving rows between partitions, DELETE through the parent",
  range,
  [
    { sql: "CREATE TABLE pd PARTITION OF p DEFAULT" },
    q("INSERT INTO p VALUES ('2024-05-01', 3) RETURNING tableoid::regclass AS part, *"),
    q("UPDATE p SET d = '2024-01-20' WHERE v = 3 RETURNING tableoid::regclass AS part, *"),
    q("UPDATE p SET v = v * 10 RETURNING tableoid::regclass AS part, v"),
    q("SELECT tableoid::regclass AS part, * FROM p ORDER BY d"),
    q("DELETE FROM p WHERE v = 20 RETURNING *"),
    q("SELECT count(*) FROM p"),
    q("SELECT count(*) FROM p WHERE d < '2024-02-01'"),
  ],
  { compareFinalState: true },
);
errorParity(
  "UPDATE of a partition may not move a row out of it",
  range,
  "UPDATE p1 SET d = '2024-02-20'",
  "constraint_check",
);
errorParity(
  "a second DEFAULT partition",
  [...range, "CREATE TABLE pd PARTITION OF p DEFAULT"],
  "CREATE TABLE pd2 PARTITION OF p DEFAULT",
);
errorParity(
  "a new partition may not take rows the DEFAULT partition holds",
  [...range, "CREATE TABLE pd PARTITION OF p DEFAULT", "INSERT INTO p VALUES ('2024-05-01', 3)"],
  "CREATE TABLE p5 PARTITION OF p FOR VALUES FROM ('2024-05-01') TO ('2024-06-01')",
  "constraint_check",
);
parity(
  "pg_class, pg_partitioned_table, pg_inherits and pg_get_partkeydef",
  [...range, "CREATE TABLE pd PARTITION OF p DEFAULT"],
  "SELECT c.relname, c.relkind, c.relispartition, c.relhassubclass, pg_get_expr(c.relpartbound, c.oid) AS bound, (SELECT inhparent::regclass::text FROM pg_inherits WHERE inhrelid = c.oid) AS parent, (SELECT partstrat::text || ' ' || partnatts || ' ' || partattrs::text || ' ' || partdefid::regclass::text FROM pg_partitioned_table WHERE partrelid = c.oid) AS part, pg_get_partkeydef(c.oid) AS keydef FROM pg_class c WHERE c.relname IN ('p', 'p1', 'p2', 'pd') ORDER BY 1",
);
sequenceParity("DETACH and ATTACH PARTITION", range, [
  { sql: "ALTER TABLE p DETACH PARTITION p1" },
  q("SELECT count(*) FROM p"),
  q("SELECT count(*) FROM p1"),
  q("SELECT relispartition FROM pg_class WHERE relname = 'p1'"),
  { sql: "ALTER TABLE p ATTACH PARTITION p1 FOR VALUES FROM ('2024-01-01') TO ('2024-02-01')" },
  q("SELECT tableoid::regclass AS part, * FROM p ORDER BY d"),
]);
errorParity(
  "ATTACH a table with rows outside the bound",
  [...range, "CREATE TABLE p3 (d date, v int)", "INSERT INTO p3 VALUES ('2025-01-01', 1)"],
  "ALTER TABLE p ATTACH PARTITION p3 FOR VALUES FROM ('2024-03-01') TO ('2024-04-01')",
  "constraint_check",
);
sequenceParity(
  "LIST partitions, NULL in a list",
  [
    "CREATE TABLE l (k text, v int) PARTITION BY LIST (k)",
    "CREATE TABLE l_ab PARTITION OF l FOR VALUES IN ('a', 'b')",
    "CREATE TABLE l_c PARTITION OF l FOR VALUES IN ('c', NULL)",
  ],
  [
    { sql: "INSERT INTO l VALUES ('a', 1), ('c', 2), (NULL, 3), ('b', 4)" },
    q("SELECT tableoid::regclass AS part, * FROM l ORDER BY v"),
    { sql: "TRUNCATE l" },
    q("SELECT count(*) FROM l"),
  ],
);
errorParity(
  "a value no list takes",
  ["CREATE TABLE l (k text, v int) PARTITION BY LIST (k)", "CREATE TABLE l_ab PARTITION OF l FOR VALUES IN ('a', 'b')"],
  "INSERT INTO l VALUES ('z', 1)",
  "constraint_check",
);
errorParity(
  "a range bound on a list partition",
  ["CREATE TABLE l (k text, v int) PARTITION BY LIST (k)"],
  "CREATE TABLE y PARTITION OF l FOR VALUES FROM (1) TO (2)",
);
errorParity(
  "overlapping list partitions",
  ["CREATE TABLE l (k text, v int) PARTITION BY LIST (k)", "CREATE TABLE l_ab PARTITION OF l FOR VALUES IN ('a', 'b')"],
  "CREATE TABLE l_b PARTITION OF l FOR VALUES IN ('b')",
);
const hash = [
  "CREATE TABLE h (id int, v text) PARTITION BY HASH (id)",
  "CREATE TABLE h0 PARTITION OF h FOR VALUES WITH (MODULUS 3, REMAINDER 0)",
  "CREATE TABLE h1 PARTITION OF h FOR VALUES WITH (MODULUS 3, REMAINDER 1)",
  "CREATE TABLE h2 PARTITION OF h FOR VALUES WITH (MODULUS 3, REMAINDER 2)",
];
parity(
  "HASH partitions place rows as PostgreSQL's partition hash does (int)",
  [...hash, "INSERT INTO h SELECT g, 'x' || g FROM generate_series(1, 40) g"],
  "SELECT tableoid::regclass AS part, array_agg(id ORDER BY id) AS ids FROM h GROUP BY 1 ORDER BY 1",
);
parity(
  "HASH partitions on text, bigint and two columns",
  [
    "CREATE TABLE ht (k text, n bigint, v int) PARTITION BY HASH (k, n)",
    "CREATE TABLE ht0 PARTITION OF ht FOR VALUES WITH (MODULUS 2, REMAINDER 0)",
    "CREATE TABLE ht1 PARTITION OF ht FOR VALUES WITH (MODULUS 2, REMAINDER 1)",
    "INSERT INTO ht SELECT 'k' || g, g * 1000000000000, g FROM generate_series(1, 30) g",
    "INSERT INTO ht VALUES (NULL, NULL, 0), ('only', NULL, -1)",
  ],
  "SELECT tableoid::regclass AS part, array_agg(v ORDER BY v) AS vs FROM ht GROUP BY 1 ORDER BY 1",
);
errorParity(
  "an overlapping hash partition",
  hash,
  "CREATE TABLE z PARTITION OF h FOR VALUES WITH (MODULUS 6, REMAINDER 3)",
);
errorParity(
  "hash moduli must divide each other",
  hash,
  "CREATE TABLE z PARTITION OF h FOR VALUES WITH (MODULUS 4, REMAINDER 0)",
);
sequenceParity(
  "keys of a partitioned table are enforced per partition (with MINVALUE / MAXVALUE bounds)",
  [
    "CREATE TABLE pk (id int, d date, PRIMARY KEY (id, d)) PARTITION BY RANGE (d)",
    "CREATE TABLE pk1 PARTITION OF pk FOR VALUES FROM (MINVALUE) TO ('2024-01-01')",
    "CREATE TABLE pk2 PARTITION OF pk FOR VALUES FROM ('2024-01-01') TO (MAXVALUE)",
  ],
  [
    { sql: "INSERT INTO pk VALUES (1, '2023-01-01'), (1, '2025-01-01')" },
    q(
      "SELECT conname, conrelid::regclass AS rel FROM pg_constraint WHERE contype = 'p' AND conrelid IN ('pk'::regclass, 'pk1'::regclass, 'pk2'::regclass) ORDER BY 2, 1",
    ),
    q("INSERT INTO pk VALUES (1, '2025-01-01') ON CONFLICT DO NOTHING RETURNING *"),
    q("SELECT tableoid::regclass AS part, * FROM pk ORDER BY d"),
  ],
);
errorParity(
  "a duplicate key in a partition",
  [
    "CREATE TABLE pk (id int, d date, PRIMARY KEY (id, d)) PARTITION BY RANGE (d)",
    "CREATE TABLE pk2 PARTITION OF pk FOR VALUES FROM ('2024-01-01') TO (MAXVALUE)",
    "INSERT INTO pk VALUES (1, '2025-01-01')",
  ],
  "INSERT INTO pk VALUES (1, '2025-01-01')",
  "constraint_unique",
);
errorParity(
  "a unique key must include the partition key",
  [],
  "CREATE TABLE bad (id int, d date, PRIMARY KEY (id)) PARTITION BY RANGE (d)",
  "unsupported",
);
errorParity(
  "PARTITION OF a table that is not partitioned",
  ["CREATE TABLE np (a int)"],
  "CREATE TABLE x PARTITION OF np FOR VALUES IN (1)",
);
sequenceParity(
  "DROP TABLE of the parent drops its partitions; sub-partitions route through two levels",
  [
    "CREATE TABLE s (region text, d date, v int) PARTITION BY LIST (region)",
    "CREATE TABLE s_eu PARTITION OF s FOR VALUES IN ('eu') PARTITION BY RANGE (d)",
    "CREATE TABLE s_eu_2024 PARTITION OF s_eu FOR VALUES FROM ('2024-01-01') TO ('2025-01-01')",
    "CREATE TABLE s_us PARTITION OF s FOR VALUES IN ('us')",
  ],
  [
    { sql: "INSERT INTO s VALUES ('eu', '2024-06-01', 1), ('us', '2020-01-01', 2)" },
    q("SELECT tableoid::regclass AS part, * FROM s ORDER BY v"),
    q("SELECT relname, relkind FROM pg_class WHERE relname LIKE 's\\_%' OR relname = 's' ORDER BY 1"),
    { sql: "DROP TABLE s" },
    q("SELECT count(*) FROM pg_class WHERE relname LIKE 's\\_%'"),
  ],
);
sequenceParity(
  "column defaults and CHECK constraints of the parent apply to the partitions",
  [
    "CREATE TABLE c (id serial, k int CHECK (k > 0), note text DEFAULT 'n') PARTITION BY RANGE (k)",
    "CREATE TABLE c1 PARTITION OF c FOR VALUES FROM (1) TO (100)",
  ],
  [q("INSERT INTO c (k) VALUES (5), (6) RETURNING *"), q("SELECT * FROM c1 ORDER BY id")],
);
errorParity(
  "a parent CHECK fails in the partition",
  [
    "CREATE TABLE c (k int CHECK (k <> 50)) PARTITION BY RANGE (k)",
    "CREATE TABLE c1 PARTITION OF c FOR VALUES FROM (1) TO (100)",
  ],
  "INSERT INTO c VALUES (50)",
  "constraint_check",
);
errorParity("COPY TO a partitioned table", range, "COPY p TO STDOUT");

test("partitions, bounds and routing survive an encoded snapshot and a rollback", () => {
  const db = new Database();
  for (const sql of range) db.exec(sql);
  db.exec("BEGIN");
  db.exec("CREATE TABLE pd PARTITION OF p DEFAULT");
  db.exec("ROLLBACK");
  expect(() => db.exec("INSERT INTO p VALUES ('2030-01-01', 9)")).toThrow(/no partition of relation "p" found for row/);
  const copy = Snapshot.decode(db.snapshot().encode()).open();
  copy.exec("INSERT INTO p VALUES ('2024-01-31', 7)");
  expect(copy.query("SELECT tableoid::regclass::text AS part, v FROM p ORDER BY v")).toEqual([
    { part: "p1", v: 1 },
    { part: "p2", v: 2 },
    { part: "p1", v: 7 },
  ]);
});

test("MERGE into a partitioned table and foreign keys to one fail loud", () => {
  const db = new Database();
  for (const sql of range) db.exec(sql);
  expect(() => db.exec("MERGE INTO p USING (SELECT 1 AS v) s ON p.v = s.v WHEN MATCHED THEN DELETE")).toThrow(
    /MERGE into a partitioned table is not supported/,
  );
  db.exec("CREATE TABLE k (id int PRIMARY KEY) PARTITION BY RANGE (id)");
  expect(() => db.exec("CREATE TABLE r (id int REFERENCES k)")).toThrow(/foreign keys referencing a partitioned table/);
});
