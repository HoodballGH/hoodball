import { parseUnits } from "viem";
import { DEAD_ADDRESS, ZERO_ADDRESS } from "./chain";
import type { RuntimeConfig } from "./types";

export type HolderFacts = {
  address: string;
  balance: bigint;
  isContract: boolean;
  isPool?: boolean;
};

export const EXCLUSION = {
  zeroBalance: "No balance",
  burn: "Burn address",
  vault: "Payout vault",
  token: "Token contract",
  excluded: "Excluded address",
  pool: "Liquidity pool",
  contract: "Contract account",
  belowMinimum: "Below the minimum balance",
} as const;

export function minBalanceWei(config: RuntimeConfig): bigint {
  const text = (config.minBalance ?? "0").trim();
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,36})?$/.test(text)) return 0n;
  const decimals = text.split(".")[1]?.length ?? 0;
  if (decimals > config.tokenDecimals) return 0n;
  try {
    return parseUnits(text, config.tokenDecimals);
  } catch {
    return 0n;
  }
}

/**
 * Single source of truth for who may win a draw. Used by the snapshot, the odds
 * lookup and the draw engine so the three can never disagree.
 */
export function exclusionReason(
  holder: HolderFacts,
  config: RuntimeConfig,
  minimum = minBalanceWei(config),
): string | null {
  const address = holder.address.toLowerCase();
  if (holder.balance <= 0n) return EXCLUSION.zeroBalance;
  if (address === ZERO_ADDRESS || address === DEAD_ADDRESS)
    return EXCLUSION.burn;
  if (address === config.vaultAddress?.toLowerCase()) return EXCLUSION.vault;
  if (address === config.tokenAddress?.toLowerCase()) return EXCLUSION.token;
  if (config.excludedAddresses.some((value) => value.toLowerCase() === address))
    return EXCLUSION.excluded;
  if (holder.isPool) return EXCLUSION.pool;
  if (holder.isContract) return EXCLUSION.contract;
  if (holder.balance < minimum) return EXCLUSION.belowMinimum;
  return null;
}

export function isEligible(
  holder: HolderFacts,
  config: RuntimeConfig,
  minimum = minBalanceWei(config),
) {
  return exclusionReason(holder, config, minimum) === null;
}

/** Addresses that are structurally excluded regardless of the holder table. */
export function excludedAddresses(config: RuntimeConfig) {
  return [
    ZERO_ADDRESS,
    DEAD_ADDRESS,
    config.tokenAddress,
    config.vaultAddress,
    ...config.excludedAddresses,
  ]
    .filter((value): value is string => Boolean(value))
    .map((value) => value.toLowerCase());
}

export function odds(balance: bigint, eligibleBalance: bigint) {
  if (balance <= 0n || eligibleBalance <= 0n)
    return { odds: 0, oneIn: null as number | null };
  const share = Number((balance * 1000000n) / eligibleBalance) / 1000000;
  return { odds: share, oneIn: share > 0 ? 1 / share : null };
}
