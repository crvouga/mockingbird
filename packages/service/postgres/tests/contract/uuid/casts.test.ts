import { parity } from "../helpers.ts";

parity("uuid to text", [], "SELECT ('a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11'::uuid)::text AS v");
parity("uuid to text lowercases", [], "SELECT ('A0EEBC99-9C0B-4EF8-BB6D-6BB9BD380A11'::uuid)::text AS v");
parity("text to uuid roundtrip", [], "SELECT (('a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11'::uuid)::text)::uuid AS v");
parity("uuid text length", [], "SELECT length(('a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11'::uuid)::text) AS v");
parity(
  "uuid text comparison via cast",
  [],
  "SELECT ('a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11'::uuid)::text LIKE 'a0%' AS v",
);
parity("uuid cast syntax variants", [], "SELECT CAST('a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11' AS uuid) AS v");
parity(
  "uuid column storage roundtrip",
  ["CREATE TABLE t (id uuid)", "INSERT INTO t VALUES ('{A0EEBC99-9C0B-4EF8-BB6D-6BB9BD380A11}')"],
  "SELECT id, id::text AS txt FROM t",
);
parity(
  "uuid distinct from comparison",
  [],
  "SELECT 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11'::uuid IS DISTINCT FROM NULL AS v",
);
