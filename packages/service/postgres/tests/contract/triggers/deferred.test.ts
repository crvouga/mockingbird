import { errorParity, sequenceParity } from "../helpers.ts";

const setup = [
  "CREATE TABLE entries (id int)",
  "CREATE FUNCTION check_entries() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF EXISTS (SELECT 1 FROM entries WHERE id < 0) THEN RAISE EXCEPTION 'invalid entries'; END IF; RETURN NEW; END $$",
  "CREATE CONSTRAINT TRIGGER validate_entry AFTER INSERT OR DELETE OR UPDATE ON entries DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_entries()",
];
sequenceParity("deferred trigger sees final valid state (#432)", setup, [
  { sql: "BEGIN" },
  { sql: "INSERT INTO entries VALUES (-1)" },
  { sql: "UPDATE entries SET id = 1" },
  { sql: "COMMIT" },
  { sql: "SELECT * FROM entries", query: true },
]);
sequenceParity("failed deferred commit rolls back writes (#432)", setup, [
  { sql: "BEGIN" },
  { sql: "INSERT INTO entries VALUES (-1)" },
  { sql: "COMMIT" },
  { sql: "SELECT * FROM entries", query: true },
]);
sequenceParity("SET CONSTRAINTS IMMEDIATE checks pending events and rollback restores them (#432)", setup, [
  { sql: "BEGIN" },
  { sql: "SAVEPOINT s" },
  { sql: "INSERT INTO entries VALUES (-1)" },
  { sql: "SET CONSTRAINTS validate_entry IMMEDIATE" },
  { sql: "ROLLBACK TO s" },
  { sql: "SET CONSTRAINTS ALL IMMEDIATE" },
  { sql: "INSERT INTO entries VALUES (1)" },
  { sql: "COMMIT" },
  { sql: "SELECT * FROM entries", query: true },
]);
sequenceParity(
  "initially immediate trigger can be deferred explicitly (#432)",
  [...setup.slice(0, 2), setup[2]!.replace("INITIALLY DEFERRED", "INITIALLY IMMEDIATE")],
  [
    { sql: "BEGIN" },
    { sql: "SET CONSTRAINTS ALL DEFERRED" },
    { sql: "INSERT INTO entries VALUES (-1)" },
    { sql: "DELETE FROM entries" },
    { sql: "SET CONSTRAINTS ALL IMMEDIATE" },
    { sql: "COMMIT" },
  ],
);
errorParity("deferred constraints still check autocommit (#432)", setup, "INSERT INTO entries VALUES (-1)");
errorParity("unknown constraint name (#432)", [...setup, "BEGIN"], "SET CONSTRAINTS missing IMMEDIATE");
