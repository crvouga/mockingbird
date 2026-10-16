import { sequenceParity } from "../helpers.ts";

for (const mode of ["IMMEDIATE", "DEFERRED"]) {
  sequenceParity(
    `constraint trigger audit writes execute once (${mode}, #432)`,
    [
      "CREATE TABLE entries (id int)",
      "CREATE TABLE audit (id int)",
      "CREATE FUNCTION log_entry() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN INSERT INTO audit VALUES (1); RETURN NEW; END $$",
      `CREATE CONSTRAINT TRIGGER log_entry AFTER INSERT ON entries DEFERRABLE INITIALLY ${mode} FOR EACH ROW EXECUTE FUNCTION log_entry()`,
    ],
    [
      { sql: "BEGIN" },
      { sql: "INSERT INTO entries VALUES (1), (2)" },
      { sql: "COMMIT" },
      { sql: "SELECT count(*) FROM audit", query: true },
    ],
  );
}
