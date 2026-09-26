import { parity } from "../helpers.ts";

const tree = [
  "CREATE TABLE org (id int, parent_id int, name text)",
  "INSERT INTO org VALUES (1, NULL, 'root'), (2, 1, 'a'), (3, 1, 'b'), (4, 2, 'a1'), (5, 2, 'a2'), (6, 3, 'b1')",
];

parity(
  "tree walk from root",
  tree,
  "WITH RECURSIVE sub AS (SELECT id, parent_id, name, 0 AS depth FROM org WHERE parent_id IS NULL UNION ALL SELECT o.id, o.parent_id, o.name, sub.depth + 1 FROM org o JOIN sub ON o.parent_id = sub.id) SELECT id, name, depth FROM sub ORDER BY id",
);
parity(
  "subtree from middle node",
  tree,
  "WITH RECURSIVE sub AS (SELECT id, name FROM org WHERE id = 2 UNION ALL SELECT o.id, o.name FROM org o JOIN sub ON o.parent_id = sub.id) SELECT id, name FROM sub ORDER BY id",
);
parity(
  "ancestor chain upward",
  tree,
  "WITH RECURSIVE up AS (SELECT id, parent_id, name FROM org WHERE id = 4 UNION ALL SELECT o.id, o.parent_id, o.name FROM org o JOIN up ON up.parent_id = o.id) SELECT id, name FROM up ORDER BY id",
);
parity(
  "path accumulation",
  tree,
  "WITH RECURSIVE sub AS (SELECT id, name::text AS path FROM org WHERE parent_id IS NULL UNION ALL SELECT o.id, sub.path || '/' || o.name FROM org o JOIN sub ON o.parent_id = sub.id) SELECT id, path FROM sub ORDER BY id",
);
parity(
  "depth-limited walk",
  tree,
  "WITH RECURSIVE sub AS (SELECT id, name, 0 AS depth FROM org WHERE parent_id IS NULL UNION ALL SELECT o.id, o.name, sub.depth + 1 FROM org o JOIN sub ON o.parent_id = sub.id WHERE sub.depth < 1) SELECT id, name, depth FROM sub ORDER BY id",
);

const graph = [
  "CREATE TABLE edges (src int, dst int)",
  "INSERT INTO edges VALUES (1, 2), (2, 3), (3, 4), (2, 4), (4, 5)",
];

parity(
  "graph reachability",
  graph,
  "WITH RECURSIVE reach(node) AS (SELECT 1 UNION SELECT e.dst FROM edges e JOIN reach r ON e.src = r.node) SELECT node FROM reach ORDER BY node",
);
parity(
  "graph reachability from isolated node",
  graph,
  "WITH RECURSIVE reach(node) AS (SELECT 99 UNION SELECT e.dst FROM edges e JOIN reach r ON e.src = r.node) SELECT node FROM reach ORDER BY node",
);
parity(
  "cycle avoidance with union dedup",
  ["CREATE TABLE edges (src int, dst int)", "INSERT INTO edges VALUES (1, 2), (2, 3), (3, 1)"],
  "WITH RECURSIVE reach(node) AS (SELECT 1 UNION SELECT e.dst FROM edges e JOIN reach r ON e.src = r.node) SELECT node FROM reach ORDER BY node",
);
parity(
  "cycle avoidance with path tracking",
  ["CREATE TABLE edges (src int, dst int)", "INSERT INTO edges VALUES (1, 2), (2, 3), (3, 1)"],
  "WITH RECURSIVE walk(node, path) AS (SELECT 1, ARRAY[1] UNION ALL SELECT e.dst, w.path || e.dst FROM edges e JOIN walk w ON e.src = w.node WHERE e.dst <> ALL (w.path)) SELECT node, array_to_string(path, '-') AS p FROM walk ORDER BY p",
);
