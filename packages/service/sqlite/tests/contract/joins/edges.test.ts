import { parity } from "../helpers.ts";

const data = [
  "CREATE TABLE users(id INTEGER,name TEXT)",
  "CREATE TABLE posts(id INTEGER,user_id INTEGER)",
  "CREATE TABLE tags(post_id INTEGER,label TEXT)",
  "INSERT INTO users VALUES (1,'Ada'),(2,'Bob'),(3,'Cy')",
  "INSERT INTO posts VALUES (10,1),(11,1),(12,2)",
  "INSERT INTO tags VALUES (10,'x'),(10,'y'),(12,'z')",
];
parity(
  "three-table join preserves matching combinations",
  data,
  "SELECT u.name,p.id,t.label FROM users u JOIN posts p ON p.user_id=u.id JOIN tags t ON t.post_id=p.id ORDER BY p.id,t.label",
);
parity(
  "USING merges the shared join column",
  [
    "CREATE TABLE a(id INTEGER,av TEXT)",
    "CREATE TABLE b(id INTEGER,bv TEXT)",
    "INSERT INTO a VALUES (1,'a'),(2,'b')",
    "INSERT INTO b VALUES (2,'B'),(3,'C')",
  ],
  "SELECT id,av,bv FROM a JOIN b USING(id)",
);
parity(
  "LEFT JOIN returns one null-extended row without matches",
  data,
  "SELECT u.id,p.id post_id FROM users u LEFT JOIN posts p ON p.user_id=u.id WHERE u.id=3",
);
parity(
  "join with empty right side returns no inner rows",
  ["CREATE TABLE a(id INTEGER)", "CREATE TABLE b(id INTEGER)", "INSERT INTO a VALUES (1),(2)"],
  "SELECT a.id,b.id bid FROM a JOIN b ON a.id=b.id",
);
parity(
  "LEFT JOIN with empty left side returns no rows",
  ["CREATE TABLE a(id INTEGER)", "CREATE TABLE b(id INTEGER)", "INSERT INTO b VALUES (1),(2)"],
  "SELECT a.id,b.id bid FROM a LEFT JOIN b ON a.id=b.id",
);
