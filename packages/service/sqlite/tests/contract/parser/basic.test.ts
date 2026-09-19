import { parity } from "../helpers.ts";

parity(
  "reserved words work as double-quoted identifiers",
  ['CREATE TABLE "select"("from" INTEGER,"where" TEXT)', "INSERT INTO \"select\" VALUES (1,'ok')"],
  'SELECT "from","where" FROM "select"',
);
parity(
  "reserved words work as bracket identifiers",
  ["CREATE TABLE [group]([order] INTEGER,[limit] TEXT)", "INSERT INTO [group] VALUES (2,'two')"],
  "SELECT [order],[limit] FROM [group]",
);
parity(
  "reserved words work as backtick identifiers",
  ["CREATE TABLE `table`(`index` INTEGER,`join` TEXT)", "INSERT INTO `table` VALUES (3,'three')"],
  "SELECT `index`,`join` FROM `table`",
);
parity("quoted alias may be a keyword", [], 'SELECT 1 AS "select",2 AS "from" ORDER BY "select"');
