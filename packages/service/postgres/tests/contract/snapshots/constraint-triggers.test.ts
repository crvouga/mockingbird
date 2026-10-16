import { expect, test } from "bun:test";
import { Database, Snapshot } from "../../../src/index.ts";

test("portable snapshots retain deferred trigger definitions and isolate transaction events (#432)", () => {
  const source = new Database();
  const opened: Database[] = [];
  try {
    source.exec("CREATE TABLE entries (id int)");
    source.exec(
      "CREATE FUNCTION check_entries() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF EXISTS (SELECT 1 FROM entries WHERE id < 0) THEN RAISE EXCEPTION 'invalid entries'; END IF; RETURN NEW; END $$",
    );
    source.exec(
      "CREATE CONSTRAINT TRIGGER validate_entry AFTER INSERT OR UPDATE ON entries DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_entries()",
    );
    const baseline = source.snapshot();
    for (const snapshot of [baseline, Snapshot.decode(baseline.encode())]) {
      const restored = snapshot.open();
      const sibling = snapshot.open();
      opened.push(restored, sibling);
      restored.exec("BEGIN");
      restored.exec("INSERT INTO entries VALUES (-1)");
      expect(() => restored.snapshot()).toThrow("cannot snapshot during a transaction");
      sibling.exec("BEGIN");
      sibling.exec("INSERT INTO entries VALUES (2)");
      sibling.exec("COMMIT");
      expect(sibling.query("SELECT * FROM entries")).toEqual([{ id: 2 }]);
      expect(() => restored.exec("COMMIT")).toThrow("invalid entries");
      expect(restored.query("SELECT * FROM entries")).toEqual([]);
      restored.exec("BEGIN");
      restored.exec("INSERT INTO entries VALUES (-3)");
      restored.exec("UPDATE entries SET id = 3");
      restored.exec("COMMIT");
      expect(restored.query("SELECT * FROM entries")).toEqual([{ id: 3 }]);
      expect(source.query("SELECT * FROM entries")).toEqual([]);
    }
  } finally {
    for (const db of opened) db.close();
    source.close();
  }
});
