import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { selectWinners, splitPot } from "../lib/draw-selection";

const seedFrom = (label: string) =>
  `0x${Buffer.from(label.padEnd(32, ".")).toString("hex")}`;
const holder = (n: number, balance: bigint) => ({
  address: `0x${n.toString(16).padStart(40, "0")}`,
  balance,
});

test("winners are drawn in proportion to balance over 20000 samples", () => {
  const holders = [
    holder(1, 5_000n * 10n ** 18n),
    holder(2, 3_000n * 10n ** 18n),
    holder(3, 1_500n * 10n ** 18n),
    holder(4, 500n * 10n ** 18n),
  ];
  const total = holders.reduce((sum, h) => sum + h.balance, 0n);
  const samples = 20000;
  const counts = new Map<string, number>();
  for (let i = 0; i < samples; i++) {
    const [winner] = selectWinners(
      `0x${i.toString(16).padStart(64, "0")}`,
      holders,
      1,
    );
    counts.set(winner.address, (counts.get(winner.address) ?? 0) + 1);
  }
  for (const entry of holders) {
    const expected = Number((entry.balance * 10000n) / total) / 10000;
    const observed = (counts.get(entry.address) ?? 0) / samples;
    assert.ok(
      Math.abs(observed - expected) <= 0.02,
      `${entry.address}: expected ~${expected}, observed ${observed}`,
    );
  }
});

test("selection is deterministic for the same seed and holder set", () => {
  const holders = Array.from({ length: 50 }, (_, i) =>
    holder(i + 1, BigInt(i + 1) * 10n ** 18n),
  );
  const seed = seedFrom("deterministic");
  const a = selectWinners(seed, holders, 5).map((h) => h.address);
  const b = selectWinners(seed, [...holders].reverse(), 5).map(
    (h) => h.address,
  );
  assert.deepEqual(a, b, "holder ordering must not change the outcome");
  assert.notDeepEqual(
    a,
    selectWinners(seedFrom("other-seed"), holders, 5).map((h) => h.address),
  );
});

test("sampling is without replacement: no duplicate winners", () => {
  const holders = Array.from({ length: 200 }, (_, i) =>
    holder(i + 1, BigInt(1 + (i % 7)) * 10n ** 18n),
  );
  for (let i = 0; i < 200; i++) {
    const winners = selectWinners(
      `0x${randomBytes(32).toString("hex")}`,
      holders,
      10,
    );
    assert.equal(winners.length, 10);
    assert.equal(new Set(winners.map((w) => w.address)).size, 10);
  }
});

test("count above the holder count returns every holder exactly once", () => {
  const holders = [holder(1, 1n), holder(2, 2n), holder(3, 3n)];
  const winners = selectWinners(seedFrom("small"), holders, 10);
  assert.equal(winners.length, 3);
  assert.equal(new Set(winners.map((w) => w.address)).size, 3);
});

test("empty input, zero count and zero balances select nobody", () => {
  assert.deepEqual(selectWinners(seedFrom("empty"), [], 3), []);
  assert.deepEqual(selectWinners(seedFrom("zero"), [holder(1, 5n)], 0), []);
  assert.deepEqual(
    selectWinners(seedFrom("dust"), [holder(1, 0n), holder(2, 0n)], 1),
    [],
  );
});

test("a malformed seed is rejected instead of silently weakening the draw", () => {
  assert.throws(() => selectWinners("0xdead", [holder(1, 1n)], 1), /32 bytes/);
});

test("the pot splits equally with the remainder going to the first winner", () => {
  assert.deepEqual(splitPot(10n, 3), [4n, 3n, 3n]);
  assert.deepEqual(splitPot(9n, 3), [3n, 3n, 3n]);
  assert.deepEqual(splitPot(0n, 3), []);
  assert.deepEqual(splitPot(2n, 3), []);
  assert.equal(
    splitPot(10n ** 18n + 7n, 4).reduce((sum, value) => sum + value, 0n),
    10n ** 18n + 7n,
  );
});
