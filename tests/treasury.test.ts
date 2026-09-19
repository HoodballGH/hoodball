import test from "node:test";
import assert from "node:assert/strict";
import { parseEther } from "viem";
import {
  choosePlan,
  moneyGate,
  type PlanInput,
  type PlanLimits,
} from "../lib/treasury";
import { sweepClaimable } from "../lib/pons";

const limits: PlanLimits = {
  minSweep: parseEther("0.002"),
  minClaim: parseEther("0.002"),
};
const base: PlanInput = {
  graduated: false,
  buybackEnabled: false,
  recipientIsVault: true,
  pendingCurveWei: 0n,
  escrowWei: 0n,
  wethWei: 0n,
};

test("money gates block sends unless MONEY_ENABLED and HOODBALL_TREASURY_ENABLED are both true", () => {
  assert.equal(moneyGate({}).open, false);
  assert.equal(moneyGate({ MONEY_ENABLED: "true" }).open, false);
  assert.equal(moneyGate({ HOODBALL_TREASURY_ENABLED: "true" }).open, false);
  assert.equal(
    moneyGate({ MONEY_ENABLED: "true", HOODBALL_TREASURY_ENABLED: "true" })
      .open,
    true,
  );
  assert.match(
    moneyGate({ MONEY_ENABLED: "true" }).reason,
    /HOODBALL_TREASURY_ENABLED/,
  );
});

test("the keeper runs at most one fee op per cycle, sweep before claim", () => {
  const everything = {
    ...base,
    pendingCurveWei: parseEther("0.01"),
    escrowWei: parseEther("0.01"),
    wethWei: parseEther("0.01"),
  };
  assert.deepEqual(choosePlan(everything, limits), { kind: "sweep" });
  assert.deepEqual(choosePlan({ ...everything, pendingCurveWei: 0n }, limits), {
    kind: "claim",
  });
  assert.deepEqual(
    choosePlan({ ...everything, pendingCurveWei: 0n, escrowWei: 0n }, limits),
    { kind: "unwrap" },
  );
  assert.equal(
    choosePlan(
      { ...everything, pendingCurveWei: 0n, escrowWei: 0n, wethWei: 0n },
      limits,
    ).kind,
    "none",
  );
});

test("dust below the minimums is left on chain", () => {
  const dust = {
    ...base,
    pendingCurveWei: parseEther("0.0001"),
    escrowWei: parseEther("0.0001"),
  };
  const choice = choosePlan(dust, limits);
  assert.equal(choice.kind, "none");
  assert.match(
    choice.kind === "none" ? choice.reason : "",
    /above the configured minimums/,
  );
});

test("curve fees that the vault cannot sweep report why instead of retrying", () => {
  const buyback = choosePlan(
    { ...base, pendingCurveWei: parseEther("0.5"), buybackEnabled: true },
    limits,
  );
  assert.equal(buyback.kind, "none");
  assert.match(buyback.kind === "none" ? buyback.reason : "", /buyback/);
  const otherRecipient = choosePlan(
    { ...base, pendingCurveWei: parseEther("0.5"), recipientIsVault: false },
    limits,
  );
  assert.match(
    otherRecipient.kind === "none" ? otherRecipient.reason : "",
    /not the vault/,
  );
  const graduated = choosePlan(
    { ...base, graduated: true, pendingCurveWei: parseEther("0.5") },
    limits,
  );
  assert.equal(graduated.kind, "none");
});

test("the creator share subtracts the protocol fee and adds the creator tax", () => {
  assert.equal(sweepClaimable(1000n, 250n, 2000), 1050n);
  assert.equal(sweepClaimable(0n, 0n, 0), 0n);
  assert.throws(() => sweepClaimable(1000n, 0n, 10001), /protocol fee share/);
});
