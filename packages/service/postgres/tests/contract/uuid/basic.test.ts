import { parity, parityTyped } from "../helpers.ts";

parity("uuid literal parses", [], "SELECT 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11'::uuid AS v");
parity("uuid uppercase normalized to lowercase", [], "SELECT 'A0EEBC99-9C0B-4EF8-BB6D-6BB9BD380A11'::uuid AS v");
parity("uuid braces format accepted", [], "SELECT '{a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11}'::uuid AS v");
parity("uuid without hyphens accepted", [], "SELECT 'a0eebc999c0b4ef8bb6d6bb9bd380a11'::uuid AS v");
parityTyped("uuid type", [], "SELECT 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11'::uuid AS v");
parity(
  "uuid equality",
  [],
  "SELECT 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11'::uuid = 'A0EEBC99-9C0B-4EF8-BB6D-6BB9BD380A11'::uuid AS v",
);
parity(
  "uuid comparison",
  [],
  "SELECT '00000000-0000-0000-0000-000000000001'::uuid < '00000000-0000-0000-0000-000000000002'::uuid AS v",
);
parity(
  "order by uuid",
  [
    "CREATE TABLE t (id uuid)",
    "INSERT INTO t VALUES ('ffffffff-ffff-ffff-ffff-ffffffffffff'), ('00000000-0000-0000-0000-000000000000'), ('a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11')",
  ],
  "SELECT id FROM t ORDER BY id",
);
