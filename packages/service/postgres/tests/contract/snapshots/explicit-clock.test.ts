import { expect, test } from "bun:test";
import { Database, Snapshot } from "../../../src/index.ts";

const now = (db: Database) => String(db.query("SELECT now() AS value")[0]?.value);

test("snapshot openWithClock overrides time explicitly while open preserves captured time", () => {
  const base = new Database({ now: new Date("2000-01-01T00:00:00.000Z") });
  const captured = base.snapshot();
  let instant = new Date("2033-05-18T03:33:20.000Z");
  for (const point of [captured, Snapshot.decode(captured.encode())]) {
    const original = point.open();
    const dated = point.openWithClock(instant);
    const ticking = point.openWithClock(() => instant);
    expect(now(original)).toContain("2000-01-01");
    expect(now(dated)).toContain("2033-05-18");
    expect(now(ticking)).toContain("2033-05-18");
    instant = new Date("2033-05-19T03:33:20.000Z");
    expect(now(ticking)).toContain("2033-05-19");
    expect(now(dated)).toContain("2033-05-18");
    original.close(); dated.close(); ticking.close();
    instant = new Date("2033-05-18T03:33:20.000Z");
  }
  base.close();
});
