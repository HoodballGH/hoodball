import test from "node:test";
import assert from "node:assert/strict";
import { applyTransfer, type BalanceState } from "../lib/indexer-state";
import { ZERO_ADDRESS } from "../lib/chain";
const alice = "0x1111111111111111111111111111111111111111";
const bob = "0x2222222222222222222222222222222222222222";
const start = "2026-01-01T00:00:00.000Z";
const later = "2026-01-01T01:00:00.000Z";

test("mint credits the receiver and stamps when it was first seen", () => {
  const state = new Map<string, BalanceState>();
  applyTransfer(state, ZERO_ADDRESS, alice, 100n, start);
  applyTransfer(state, ZERO_ADDRESS, alice, 25n, later);
  assert.deepEqual(state.get(alice), { balance: 125n, firstSeenAt: start });
});

test("a transfer moves balance and gives the receiver its own first-seen stamp", () => {
  const state = new Map<string, BalanceState>([
    [alice, { balance: 100n, firstSeenAt: start }],
  ]);
  applyTransfer(state, alice, bob, 25n, later);
  assert.deepEqual(state.get(alice), { balance: 75n, firstSeenAt: start });
  assert.deepEqual(state.get(bob), { balance: 25n, firstSeenAt: later });
});

test("selling out to zero and buying back keeps the original first-seen stamp", () => {
  const state = new Map<string, BalanceState>([
    [alice, { balance: 100n, firstSeenAt: start }],
  ]);
  applyTransfer(state, alice, bob, 100n, later);
  assert.deepEqual(state.get(alice), { balance: 0n, firstSeenAt: start });
  applyTransfer(state, bob, alice, 5n, "2026-01-02T00:00:00.000Z");
  assert.equal(state.get(alice)?.balance, 5n);
  assert.equal(state.get(alice)?.firstSeenAt, start);
});

test("self and zero transfers cannot mutate balances", () => {
  const state = new Map<string, BalanceState>([
    [alice, { balance: 100n, firstSeenAt: start }],
  ]);
  applyTransfer(state, alice, alice, 100n, later);
  applyTransfer(state, bob, alice, 0n, later);
  assert.deepEqual(state.get(alice), { balance: 100n, firstSeenAt: start });
  assert.equal(state.has(bob), false);
});

test("missing mint history fails closed instead of inventing sender balance", () => {
  assert.throws(
    () => applyTransfer(new Map(), alice, bob, 1n, start),
    /full token history/,
  );
});

test("burns reduce balance and never create a zero-address holder", () => {
  const state = new Map<string, BalanceState>([
    [alice, { balance: 100n, firstSeenAt: start }],
  ]);
  applyTransfer(state, alice, ZERO_ADDRESS, 30n, later);
  assert.equal(state.get(alice)?.balance, 70n);
  assert.equal(state.has(ZERO_ADDRESS), false);
});

test("balances retain precision well beyond safe integers", () => {
  const state = new Map<string, BalanceState>();
  const amount = (1n << 255n) + 123n;
  applyTransfer(state, ZERO_ADDRESS, alice, amount, start);
  applyTransfer(state, alice, bob, amount - 1n, later);
  assert.equal(state.get(alice)?.balance, 1n);
  assert.equal(state.get(bob)?.balance, amount - 1n);
});

test("negative transfer values fail validation before mutating balances", () => {
  const state = new Map<string, BalanceState>([
    [alice, { balance: 100n, firstSeenAt: start }],
  ]);
  assert.throws(
    () => applyTransfer(state, alice, bob, -1n, later),
    /Negative transfer/,
  );
  assert.equal(state.get(alice)?.balance, 100n);
});
