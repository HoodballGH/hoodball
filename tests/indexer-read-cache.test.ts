import test from "node:test";
import assert from "node:assert/strict";
import { createReadCache } from "../lib/read-cache";
test("100 simultaneous public ledger reads share one query and cache its result", async () => {
  const cache = createReadCache();
  let calls = 0;
  const results = await Promise.all(Array.from({ length: 100 }, () => cache.get("activity:0", async () => { calls++; return { rows: [1, 2, 3] }; })));
  assert.equal(calls, 1);
  assert.ok(results.every(result => result === results[0]));
  await cache.get("activity:0", async () => { calls++; return { rows: [] }; });
  assert.equal(calls, 1);
});
test("TTL expiry, bounded eviction, and explicit invalidation refresh public data", async () => {
  let now = 0; let calls = 0;
  const cache = createReadCache(2, 3000, () => now);
  const read = async () => ++calls;
  assert.equal(await cache.get("a", read), 1);
  now = 2999; assert.equal(await cache.get("a", read), 1);
  now = 3000; assert.equal(await cache.get("a", read), 2);
  await cache.get("b", read); await cache.get("c", read);
  assert.equal(await cache.get("a", read), 5);
  cache.invalidate("a"); assert.equal(await cache.get("a", read), 6);
});
test("failed queries are evicted so transient errors recover on the next read", async () => {
  const cache = createReadCache();
  let calls = 0;
  await assert.rejects(cache.get("rounds:0", async () => { calls++; throw new Error("connection lost"); }), /connection lost/);
  assert.equal(await cache.get("rounds:0", async () => { calls++; return "recovered"; }), "recovered");
  assert.equal(calls, 2);
});
