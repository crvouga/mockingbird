import { queryErrorParity } from "../helpers.ts";

const setup = ["CREATE VIRTUAL TABLE docs USING fts5(content)", "INSERT INTO docs VALUES ('hello')"];

queryErrorParity("FTS5 rejects lone star prefix", setup, "SELECT rowid FROM docs WHERE content MATCH '*'");
queryErrorParity("FTS5 rejects double star prefix", setup, "SELECT rowid FROM docs WHERE content MATCH '**'");
queryErrorParity("FTS5 rejects triple star prefix", setup, "SELECT rowid FROM docs WHERE content MATCH '***'");
queryErrorParity("FTS5 rejects unbalanced paren", setup, "SELECT rowid FROM docs WHERE content MATCH '((broken'");
