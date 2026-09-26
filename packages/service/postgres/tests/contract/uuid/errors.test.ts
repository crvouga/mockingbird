import { queryErrorParity } from "../helpers.ts";

queryErrorParity("uuid too short", [], "SELECT 'a0eebc99'::uuid", "invalid_text_representation");
queryErrorParity(
  "uuid invalid characters",
  [],
  "SELECT 'g0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11'::uuid",
  "invalid_text_representation",
);
queryErrorParity(
  "uuid too long",
  [],
  "SELECT 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11ff'::uuid",
  "invalid_text_representation",
);
queryErrorParity("uuid empty string", [], "SELECT ''::uuid", "invalid_text_representation");
queryErrorParity(
  "uuid misplaced hyphens",
  [],
  "SELECT 'a0eebc999-c0b-4ef8-bb6d-6bb9bd380a11'::uuid",
  "invalid_text_representation",
);
queryErrorParity("uuid random word", [], "SELECT 'not-a-uuid'::uuid", "invalid_text_representation");
queryErrorParity(
  "insert invalid uuid into column",
  ["CREATE TABLE t (id uuid)"],
  "INSERT INTO t VALUES ('xyz')",
  "invalid_text_representation",
);
