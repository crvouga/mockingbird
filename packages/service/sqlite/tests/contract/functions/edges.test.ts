import { parity } from "../helpers.ts";

parity("printf formats integer and string substitutions", [], "SELECT printf('%d:%s',42,'ok') value");
parity("printf coerces numeric text for percent d", [], "SELECT printf('%d','17') value");
parity("substr negative start counts from the end", [], "SELECT substr('abcdef',-3,2) a,substr('abcdef',-2) b");
parity("replace with empty search returns input unchanged", [], "SELECT replace('abc','','x') value");
parity("round with one digit follows SQLite", [], "SELECT round(2.34,1) a,round(2.35,1) b,round(-2.35,1) c");
