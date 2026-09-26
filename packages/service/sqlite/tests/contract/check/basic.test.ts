import { errorParity, parity } from "../helpers.ts";

errorParity(
  "column CHECK rejects false expression",
  ["CREATE TABLE products(price INTEGER CHECK(price>=0))"],
  "INSERT INTO products VALUES (-1)",
  "constraint_check",
);
parity(
  "CHECK accepts true expression",
  ["CREATE TABLE products(price INTEGER CHECK(price>=0))", "INSERT INTO products VALUES (0),(10)"],
  "SELECT * FROM products ORDER BY price",
);
parity(
  "CHECK accepts NULL result",
  ["CREATE TABLE products(price INTEGER CHECK(price>=0))", "INSERT INTO products VALUES (NULL)"],
  "SELECT price,typeof(price) kind FROM products",
);
errorParity(
  "table CHECK can reference multiple columns",
  ["CREATE TABLE ranges(lo INTEGER,hi INTEGER,CHECK(lo<=hi))"],
  "INSERT INTO ranges VALUES (5,2)",
  "constraint_check",
);
