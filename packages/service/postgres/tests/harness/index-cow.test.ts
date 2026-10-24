import { expect, test } from "bun:test";
import { IndexStore } from "../../src/indexes/index.ts";

test("index forks detach only mutated buckets and isolate writes in every direction", () => {
  const root = new IndexStore("test");
  root.insert("key", 1);
  const first = root.clone();
  root.insert("key", 2);
  const second = root.clone();
  first.remove("key", 1);
  first.insert("key", 3);
  expect(root.lookup("key")).toEqual([1, 2]);
  expect(first.lookup("key")).toEqual([3]);
  expect(second.lookup("key")).toEqual([1, 2]);
  second.remove("key", 2);
  expect(root.lookup("key")).toEqual([1, 2]);
  expect(second.lookup("key")).toEqual([1]);
  root.clear();
  expect(first.lookup("key")).toEqual([3]);
  expect(second.lookup("key")).toEqual([1]);
});
