import test from "node:test";
import assert from "node:assert/strict";
import { snapshotVersion, type VersionInput } from "../lib/snapshot-version";

function input(): VersionInput {
  return {
    config: {
      tokenAddress: "0x1111111111111111111111111111111111111111",
      drawIntervalSeconds: 3600,
    },
    indexer: {
      phase: "live",
      error: null,
      halted: false,
      totalSupply: "1000",
      status: "live",
    },
    holders: [
      { address: "0xaaaa", balance: "600", isContract: false, isPool: false },
      { address: "0xbbbb", balance: "400", isContract: true, isPool: true },
    ],
    transferIds: ["0x01:0", "0x02:1:swap"],
    draws: [{ id: "d1", status: "paid", revealed: true }],
    payouts: [{ id: "d1:0xaaaa", status: "confirmed", txHash: "0xdead" }],
    drawsMeta: {
      gate: "ok",
      enabled: true,
      intervalSeconds: 3600,
      lastDrawAt: "2026-03-01T00:00:00.000Z",
      totalDraws: 1,
      totalPaidWei: "1000",
      pending: { queued: 0, signed: 0, submitted: 0, review: 0 },
    },
    jackpot: { potWei: "5000", vaultEthWei: "25000" },
  };
}

test("version is a stable 16-char hex digest for identical rows", () => {
  const a = snapshotVersion(input());
  const b = snapshotVersion(input());
  assert.match(a, /^[0-9a-f]{16}$/);
  assert.equal(a, b);
});

test("version ignores wall-clock but changes when real data changes", () => {
  const base = snapshotVersion(input());
  const balance = input();
  balance.holders = [
    { ...[...balance.holders][0], balance: "601" },
    [...balance.holders][1],
  ];
  assert.notEqual(snapshotVersion(balance), base);

  const pooled = input();
  pooled.holders = [
    { ...[...pooled.holders][0], isPool: true },
    [...pooled.holders][1],
  ];
  assert.notEqual(snapshotVersion(pooled), base);

  const payout = input();
  payout.payouts = [{ id: "d1:0xaaaa", status: "submitted", txHash: "0xdead" }];
  assert.notEqual(snapshotVersion(payout), base);

  const revealed = input();
  revealed.draws = [{ id: "d1", status: "paid", revealed: false }];
  assert.notEqual(snapshotVersion(revealed), base);

  const gate = input();
  gate.drawsMeta.gate = "paused";
  assert.notEqual(snapshotVersion(gate), base);

  const pending = input();
  pending.drawsMeta.pending.queued = 3;
  assert.notEqual(snapshotVersion(pending), base);

  const jackpot = input();
  jackpot.jackpot = { potWei: "5001", vaultEthWei: "25000" };
  assert.notEqual(snapshotVersion(jackpot), base);

  const supply = input();
  supply.indexer.totalSupply = "1001";
  assert.notEqual(snapshotVersion(supply), base);
});
