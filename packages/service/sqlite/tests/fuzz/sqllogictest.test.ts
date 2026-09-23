import { describe, test } from "bun:test";
import { listSltFiles, runSltFile } from "./slt-runner.ts";

describe("sqllogictest differential", () => {
  const files = listSltFiles();
  test(`vendor corpus (${files.length} files)`, () => {
    for (const file of files) {
      const label = file.split("/").pop() ?? file;
      runSltFile(file, label);
    }
  });
});
