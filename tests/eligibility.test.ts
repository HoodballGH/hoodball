import test from "node:test";
import assert from "node:assert/strict";
import { parseUnits } from "viem";
import { DEAD_ADDRESS, ZERO_ADDRESS } from "../lib/chain";
import {
  EXCLUSION,
  exclusionReason,
  isEligible,
  minBalanceWei,
  odds,
} from "../lib/eligibility";
import { defaultConfig } from "../lib/db";
import type { RuntimeConfig } from "../lib/types";

const token = "0x1111111111111111111111111111111111111111";
const vault = "0x2222222222222222222222222222222222222222";
const pool = "0x3333333333333333333333333333333333333333";
const excluded = "0x4444444444444444444444444444444444444444";
const wallet = "0x5555555555555555555555555555555555555555";
const config: RuntimeConfig = {
  ...defaultConfig,
  tokenAddress: token,
  vaultAddress: vault,
  excludedAddresses: [excluded],
};
const facts = (address: string, balance: bigint, extra = {}) => ({
  address,
  balance,
  isContract: false,
  ...extra,
});
const one = parseUnits("1", 18);

test("a funded externally owned wallet is the only eligible shape", () => {
  assert.equal(exclusionReason(facts(wallet, one), config), null);
  assert.equal(isEligible(facts(wallet, one), config), true);
});

test("pools, contracts, burns, the vault and the token itself never win", () => {
  assert.equal(
    exclusionReason(facts(pool, one, { isPool: true }), config),
    EXCLUSION.pool,
  );
  assert.equal(
    exclusionReason(facts(wallet, one, { isContract: true }), config),
    EXCLUSION.contract,
  );
  assert.equal(
    exclusionReason(facts(ZERO_ADDRESS, one), config),
    EXCLUSION.burn,
  );
  assert.equal(
    exclusionReason(facts(DEAD_ADDRESS, one), config),
    EXCLUSION.burn,
  );
  assert.equal(exclusionReason(facts(vault, one), config), EXCLUSION.vault);
  assert.equal(exclusionReason(facts(token, one), config), EXCLUSION.token);
  assert.equal(
    exclusionReason(facts(excluded, one), config),
    EXCLUSION.excluded,
  );
  assert.equal(
    exclusionReason(facts(wallet, 0n), config),
    EXCLUSION.zeroBalance,
  );
  assert.equal(
    exclusionReason(facts(vault.toUpperCase(), one), config),
    EXCLUSION.vault,
    "address comparison must be case-insensitive",
  );
});

test("a pool address is excluded even before code detection marks it a contract", () => {
  assert.equal(
    exclusionReason(
      facts(pool, one, { isPool: true, isContract: false }),
      config,
    ),
    EXCLUSION.pool,
  );
});

test("minBalance is parsed at token precision and enforced", () => {
  const gated = { ...config, minBalance: "100" };
  assert.equal(minBalanceWei(gated), parseUnits("100", 18));
  assert.equal(
    exclusionReason(facts(wallet, parseUnits("99.9", 18)), gated),
    EXCLUSION.belowMinimum,
  );
  assert.equal(
    exclusionReason(facts(wallet, parseUnits("100", 18)), gated),
    null,
  );
  assert.equal(minBalanceWei({ ...config, minBalance: "0" }), 0n);
  assert.equal(minBalanceWei({ ...config, minBalance: "nonsense" }), 0n);
  assert.equal(
    minBalanceWei({ ...config, minBalance: "0.5", tokenDecimals: 0 }),
    0n,
    "precision beyond the token's decimals must not round a holder out",
  );
});

test("odds are the balance share and its one-in-N inverse", () => {
  assert.deepEqual(odds(25n, 100n), { odds: 0.25, oneIn: 4 });
  assert.deepEqual(odds(0n, 100n), { odds: 0, oneIn: null });
  assert.deepEqual(odds(5n, 0n), { odds: 0, oneIn: null });
  assert.equal(odds(one, one * 1000n).oneIn, 1000);
});
