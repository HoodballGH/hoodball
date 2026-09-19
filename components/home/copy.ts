export const GATE_COPY: Record<string, string> = {
  no_token: "Draws start once the token address is set.",
  indexer_not_live: "Indexer is still catching up with the chain.",
  money_disabled: "Payouts are disabled in this environment.",
  no_vault_key: "The vault signer is not configured yet.",
  vault_mismatch: "The vault signer does not match the configured vault.",
  unsupported_quote:
    "This launch is not quoted in ETH, so the pot cannot be paid out.",
  paused: "Draws are paused by the operator.",
};

export const gateSentence = (gate: string) =>
  GATE_COPY[gate] ?? "Draws are on hold.";

export const EXCLUSION_COPY: Record<string, string> = {
  pool: "liquidity pool",
  liquidity_pool: "a liquidity pool",
  contract: "contract",
  vault: "vault",
  token: "token contract",
  token_contract: "token contract",
  excluded: "excluded",
  burn: "burn address",
  zero: "burn address",
  dead: "burn address",
  below_minimum: "below minimum",
  min_balance: "below minimum",
  no_balance: "no balance",
  zero_balance: "no balance",
  contract_account: "a contract account",
  payout_vault: "the payout vault",
  burn_address: "a burn address",
  excluded_address: "excluded by the operator",
  below_the_minimum_balance: "below the minimum balance",
};

export const exclusionSentence = (reason: string | null) => {
  if (!reason) return "not eligible";
  const key = reason.toLowerCase().replace(/\s+/g, "_");
  if (EXCLUSION_COPY[key]) return EXCLUSION_COPY[key];
  const plain = reason.replace(/_/g, " ");
  return plain.charAt(0).toLowerCase() + plain.slice(1);
};

export const CHAIN_STATUS_COPY: Record<string, string> = {
  prelaunch: "Pre-launch",
  syncing: "Syncing",
  live: "Live",
  error: "Error",
};

export const DRAW_STATUS_COPY: Record<string, string> = {
  scheduled: "Scheduled",
  paid: "Paid",
  rolled_over: "Rolled over",
  skipped: "Skipped",
  review: "Review",
};
