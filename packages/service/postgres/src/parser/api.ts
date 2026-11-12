import type { Expr, SelectStmt, Statement, TypeName } from "../ast/nodes.ts";
import type { Token } from "../lexer/tokenize.ts";

/**
 * The token cursor and sub-parsers of {@link Parser}, for grammar that lives in its own module
 * (`src/parser/ext-*.ts`) instead of the main recursive-descent parser.
 */
export interface ParserApi {
  pos: number;
  peek(offset?: number): Token;
  next(): Token;
  atKw(word: string, offset?: number): boolean;
  eatKw(word: string): boolean;
  expectKw(word: string): void;
  atPunct(p: string, offset?: number): boolean;
  eatPunct(p: string): boolean;
  expectPunct(p: string): void;
  atOp(op: string, offset?: number): boolean;
  eatOp(op: string): boolean;
  errorAt(token: Token, message: string): never;
  ident(allowReserved?: boolean): string;
  qualifiedName(): string[];
  parseExpr(): Expr;
  parseTypeName(): TypeName;
  parseSelectStmt(): SelectStmt;
  parseStatement(): Statement;
  parseIfExists(): boolean;
  parseIfNotExists(): boolean;
  atStatementEnd(): boolean;
}
