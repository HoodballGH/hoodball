import test from "node:test";
import assert from "node:assert/strict";
import {
  cycleIdFor,
  drawGate,
  dueCycle,
  nextDrawAtMs,
  scheduledAtMs,
  type GateInput,
} from "../lib/draws";

const HOUR = 3600;

test("cycles and boundaries are aligned to UTC multiples of the interval", () => {
  const boundary = Date.UTC(2026, 0, 1, 12, 0, 0);
  assert.equal(cycleIdFor(boundary, HOUR), boundary / 1000 / HOUR);
  assert.equal(scheduledAtMs(cycleIdFor(boundary, HOUR), HOUR), boundary);
  assert.equal(
    cycleIdFor(boundary + 59 * 60 * 1000, HOUR),
    cycleIdFor(boundary, HOUR),
  );
  assert.equal(
    cycleIdFor(boundary + 60 * 60 * 1000, HOUR),
    cycleIdFor(boundary, HOUR) + 1,
  );
});

test("the countdown target is the next boundary, never the current instant", () => {
  const boundary = Date.UTC(2026, 0, 1, 12, 0, 0);
  assert.equal(nextDrawAtMs(boundary + 1000, HOUR), boundary + HOUR * 1000);
  assert.equal(nextDrawAtMs(boundary, HOUR), boundary + HOUR * 1000);
  assert.equal(
    nextDrawAtMs(boundary + (HOUR - 1) * 1000, HOUR),
    boundary + HOUR * 1000,
  );
  assert.equal(nextDrawAtMs(boundary + 90 * 1000, 300), boundary + 300 * 1000);
});

test("only the latest missed cycle runs on recovery, and never twice", () => {
  const boundary = Date.UTC(2026, 0, 1, 12, 0, 0);
  const current = cycleIdFor(boundary, HOUR);
  assert.equal(dueCycle(boundary + 5000, HOUR, null), current);
  assert.equal(dueCycle(boundary + 5000, HOUR, current - 6), current);
  assert.equal(dueCycle(boundary + 5000, HOUR, current), null);
  assert.equal(dueCycle(boundary + 5000, HOUR, current + 1), null);
  assert.equal(
    dueCycle(boundary + HOUR * 1000 + 1, HOUR, current),
    current + 1,
  );
});

const open: GateInput = {
  hasToken: true,
  indexerLive: true,
  moneyEnabled: true,
  hasVaultKey: true,
  vaultMatches: true,
  quoteSupported: true,
  enabled: true,
};

test("gate reasons are reported in priority order", () => {
  assert.equal(drawGate(open), "ok");
  assert.equal(drawGate({ ...open, enabled: false }), "paused");
  assert.equal(
    drawGate({ ...open, quoteSupported: false, enabled: false }),
    "unsupported_quote",
  );
  assert.equal(
    drawGate({ ...open, vaultMatches: false, quoteSupported: false }),
    "vault_mismatch",
  );
  assert.equal(
    drawGate({ ...open, hasVaultKey: false, vaultMatches: false }),
    "no_vault_key",
  );
  assert.equal(
    drawGate({ ...open, moneyEnabled: false, hasVaultKey: false }),
    "money_disabled",
  );
  assert.equal(
    drawGate({ ...open, indexerLive: false, moneyEnabled: false }),
    "indexer_not_live",
  );
  assert.equal(
    drawGate({ ...open, hasToken: false, indexerLive: false }),
    "no_token",
  );
});
