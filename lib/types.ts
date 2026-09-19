export type RuntimeConfig = {
  tokenAddress: string | null;
  startBlock: number | null;
  tokenSymbol: string;
  tokenName: string;
  tokenDecimals: number;
  vaultAddress: string | null;
  excludedAddresses: string[];
  drawsEnabled: boolean;
  drawIntervalSeconds: number;
  winnersPerDraw: number;
  minBalance: string;
  twitterUrl: string | null;
};

export type Holder = {
  address: string;
  balance: string;
  balanceFormatted: string;
  sharePct: number;
  eligible: boolean;
  exclusionReason: string | null;
  rank: number;
  explorerUrl: string;
};

export type Payout = {
  id: string;
  recipient: string;
  amountWei: string;
  amountEth: string;
  amountUsd: number | null;
  balanceFormatted: string;
  oddsPct: number;
  status: string;
  txHash: string | null;
  explorerUrl: string | null;
  confirmedAt: string | null;
};

export type DrawStatus =
  "scheduled" | "paid" | "rolled_over" | "skipped" | "review";

export type DrawRecord = {
  id: string;
  cycleId: number;
  scheduledAt: string;
  executedAt: string | null;
  snapshotBlock: number | null;
  status: DrawStatus;
  potWei: string;
  potEth: string;
  potUsd: number | null;
  eligibleHolders: number;
  seedHash: string | null;
  seed: string | null;
  skipReason: string | null;
  payouts: Payout[];
};

export type DrawGate =
  | "no_token"
  | "indexer_not_live"
  | "money_disabled"
  | "no_vault_key"
  | "vault_mismatch"
  | "unsupported_quote"
  | "paused"
  | "ok";

export type DrawsMeta = {
  enabled: boolean;
  gate: DrawGate;
  intervalSeconds: number;
  nextDrawAt: string;
  lastDrawAt: string | null;
  totalDraws: number;
  totalPaidWei: string;
  totalPaidEth: string;
  totalPaidUsd: number | null;
  pending: {
    queued: number;
    signed: number;
    submitted: number;
    review: number;
  };
};

export type Jackpot = {
  potWei: string;
  potEth: string;
  potUsd: number | null;
  vaultEthWei: string | null;
  vaultWethWei?: string | null;
  gasReserveWei: string;
  claimableCurveWei: string | null;
  claimableEscrowWei: string | null;
  ethUsd: number | null;
};

export type Activity = {
  id: string;
  type: "mint" | "burn" | "transfer" | "payout" | "swap";
  txHash: string;
  from: string;
  to: string;
  amount: string;
  symbol: string;
  timestamp: string;
  blockNumber: number;
  explorerUrl: string;
};

export type MarketData = {
  source: "none" | "curve" | "pons-api" | "dexscreener";
  phase: "prelaunch" | "curve" | "graduating" | "pool" | "unknown";
  curveAddress: string | null;
  pairSymbol: string | null;
  priceEth: number | null;
  priceUsd: number | null;
  marketCapUsd: number | null;
  marketCapEth: number | null;
  ethUsd: number | null;
  progress: number | null;
  raisedEth: number | null;
  graduationThresholdEth: number | null;
  launchSupply: string | null;
  volume24hUsd: number | null;
  priceChange24hPct: number | null;
  liquidityUsd: number | null;
  sparkline: number[];
  updatedAt: string;
  error: string | null;
};

export type TreasuryOp = {
  id: string;
  kind: "sweep" | "claim" | "unwrap";
  status: string;
  amountIn: string | null;
  amountOut: string | null;
  txHash: string | null;
  explorerUrl: string | null;
  createdAt: string;
  reason: string | null;
};

export type TreasuryData = {
  enabled: boolean;
  status: string;
  vaultEth: string | null;
  vaultEthUsd: number | null;
  gasReserveEth: string;
  claimable: {
    curveEth: string | null;
    escrowEth: string | null;
    totalEth: string | null;
  };
  totals: {
    claimedEth: string;
    sweptEth: string;
    incomeEth: string;
    claims: number;
    sweeps: number;
  };
  launch: {
    isPons: boolean;
    phase: string;
    graduated: boolean;
    buybackEnabled: boolean;
    creatorTaxBps: number | null;
    creatorFeeRecipientIsVault: boolean | null;
    curveAddress: string | null;
    escrowAddress: string;
    quoteSymbol: string | null;
    isNativeQuote: boolean | null;
    pendingOps: number;
  };
  recent: TreasuryOp[];
  updatedAt: string;
};

export type ChainStatus = "prelaunch" | "syncing" | "live" | "error";

export type Snapshot = {
  updatedAt: string;
  version: string;
  serverTime: string;
  config: RuntimeConfig;
  chain: {
    id: number;
    name: string;
    explorerUrl: string;
    headBlock: number | null;
    indexedBlock: number | null;
    confirmations: number;
    status: ChainStatus;
    error: string | null;
    lastSyncedAt: string | null;
  };
  stats: {
    holders: number;
    eligibleHolders: number;
    eligibleBalance: string;
    totalSupply: string | null;
    drawsPaid: number;
  };
  topHolders: Holder[];
  recentDraws: DrawRecord[];
  activity: Activity[];
  jackpot: Jackpot;
  draws: DrawsMeta;
  market: MarketData;
  treasury: TreasuryData;
  vault: {
    address: string | null;
    explorerUrl: string | null;
    ethWei: string | null;
    status: string;
  };
};

export type OddsResult = {
  address: string;
  balance: string;
  balanceFormatted: string;
  eligible: boolean;
  exclusionReason: string | null;
  odds: number;
  oneIn: number | null;
  eligibleHolders: number;
  nextDrawAt: string;
};
