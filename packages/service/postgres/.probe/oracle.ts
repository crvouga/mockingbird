import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import { serve } from "../src/wire/index.ts";
import { Database } from "../src/index.ts";
import { RawClient, hex, rowDescription, dataRow, parameterOids, errorFields } from "../tests/wire/raw-client.ts";

const queries: string[] = JSON.parse(await Bun.file(process.argv[2] as string).text());
const dir = await mkdtemp(join(tmpdir(), "probe-"));
const port = 55000 + Math.floor(Math.random() * 1000);
const pgs = new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "postgres", port, persistent: false, authMethod: "trust" as any, postgresFlags: ["-c", "timezone=UTC"], onLog: () => {}, onError: () => {} });
console.log("init"); await pgs.initialise(); console.log("start"); await pgs.start(); console.log("started");
const emu = await serve({ database: new Database({ now: "system" }) });
async function run(label: string, p: number) {
  const c = await RawClient.open(p, { user: "postgres" });
  await c.simple("SET TIME ZONE 'UTC'");
  console.log("== " + label);
  for (const q of queries) {
    c.parse("s", q); c.describe("S", "s");
    const m = await c.sync();
    const out: string[] = [];
    for (const x of m) {
      if (x.type === "t") out.push("params=" + JSON.stringify(parameterOids(x)));
      if (x.type === "T") out.push("cols=" + JSON.stringify(rowDescription(x).map(c => c.oid)));
      if (x.type === "n") out.push("NoData");
      if (x.type === "E") out.push("ERR " + JSON.stringify(errorFields(x)));
    }
    let row = "";
    if (!m.some(x => x.type === "E")) {
      c.bind({ statement: "s", resultFormats: [1] }); c.execute();
      const r = await c.sync();
      for (const x of r) { if (x.type === "D") row = dataRow(x).map(v => v === null ? "NULL" : hex(v)).join(","); if (x.type === "E") row = "ERR " + JSON.stringify(errorFields(x)); }
    }
    console.log(q.padEnd(60), out.join(" "), "|", row);
    c.closeStatement("s");
    await c.sync();
  }
  c.close();
}
try { await run("oracle", port); await run("emulator", emu.port); } finally { await emu.close(); await pgs.stop(); await rm(dir, {recursive:true,force:true}); }
process.exit(0);
