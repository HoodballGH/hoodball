import { formatEther, formatUnits } from "viem";
import { CHAIN_ID, CONFIRMATIONS, EXPLORER_URL, ZERO_ADDRESS } from "./chain";
import { defaultConfig, ensureSchema, pool, readConfig } from "./db";
import {
  drawStatusText,
  emptyDrawsMeta,
  gateFor,
  GATE_REASONS,
  getDrawsMeta,
  limits as drawLimits,
  listDraws,
  nextDrawAtMs,
  payoutActivity,
} from "./draws";
import { exclusionReason, minBalanceWei, odds } from "./eligibility";
import { emptyMarket, getMarket } from "./market";
import { ethUsdCached, getPrices } from "./prices";
import { shortHash, snapshotVersion } from "./snapshot-version";
import { emptyTreasury, getTreasurySnapshot } from "./treasury";
import type {
  Activity,
  DrawRecord,
  Holder,
  OddsResult,
  RuntimeConfig,
  Snapshot,
} from "./types";

type Shared = {
  snapshot: Snapshot | null;
  holders: Holder[];
  eligibleBalance: bigint;
  refreshing: Promise<void> | null;
  refreshedAt: number;
  broadcastAt: number;
  listeners: Set<(snapshot: Snapshot) => void>;
};
const KEEPALIVE_MS = 30000;
const globalCache = globalThis as typeof globalThis & {
  hoodballShared?: Shared;
};
const shared = (globalCache.hoodballShared ??= {
  snapshot: null,
  holders: [],
  eligibleBalance: 0n,
  refreshing: null,
  refreshedAt: 0,
  broadcastAt: 0,
  listeners: new Set(),
});
shared.broadcastAt ??= 0;

export function emptySnapshot(error: string | null = null): Snapshot {
  const now = new Date().toISOString();
  return {
    updatedAt: now,
    version: shortHash(`empty:${error ?? ""}`),
    serverTime: now,
    config: { ...defaultConfig },
    chain: {
      id: CHAIN_ID,
      name: "Robinhood Chain",
      explorerUrl: EXPLORER_URL,
      headBlock: null,
      indexedBlock: null,
      confirmations: CONFIRMATIONS,
      status: error ? "error" : "prelaunch",
      error,
      lastSyncedAt: null,
    },
    stats: {
      holders: 0,
      eligibleHolders: 0,
      eligibleBalance: "0",
      totalSupply: null,
      drawsPaid: 0,
    },
    topHolders: [],
    recentDraws: [],
    activity: [],
    jackpot: {
      potWei: "0",
      potEth: "0",
      potUsd: null,
      vaultEthWei: null,
      gasReserveWei: drawLimits.gasReserve().toString(),
      claimableCurveWei: null,
      claimableEscrowWei: null,
      ethUsd: null,
    },
    draws: emptyDrawsMeta(defaultConfig.drawIntervalSeconds),
    market: emptyMarket(),
    treasury: emptyTreasury(),
    vault: {
      address: null,
      explorerUrl: null,
      ethWei: null,
      status: "Vault not configured",
    },
  };
}

function buildHolders(
  rows: {
    address: string;
    balance: string;
    is_contract: boolean;
    is_pool: boolean;
  }[],
  config: RuntimeConfig,
) {
  const minimum = minBalanceWei(config);
  const eligibleBalance = rows.reduce((sum, row) => {
    const balance = BigInt(row.balance);
    return exclusionReason(
      {
        address: row.address,
        balance,
        isContract: row.is_contract,
        isPool: row.is_pool,
      },
      config,
      minimum,
    ) === null
      ? sum + balance
      : sum;
  }, 0n);
  const total = rows.reduce((sum, row) => sum + BigInt(row.balance), 0n);
  const holders: Holder[] = rows.map((row, index) => {
    const balance = BigInt(row.balance);
    const reason = exclusionReason(
      {
        address: row.address,
        balance,
        isContract: row.is_contract,
        isPool: row.is_pool,
      },
      config,
      minimum,
    );
    return {
      address: row.address,
      balance: row.balance,
      balanceFormatted: formatUnits(balance, config.tokenDecimals),
      sharePct: total > 0n ? Number((balance * 1000000n) / total) / 10000 : 0,
      eligible: reason === null,
      exclusionReason: reason,
      rank: index + 1,
      explorerUrl: `${EXPLORER_URL}/address/${row.address}`,
    };
  });
  return { holders, eligibleBalance };
}

async function rebuild() {
  const previousVersion = shared.snapshot?.version;
  let client;
  try {
    await ensureSchema();
    client = await pool().connect();
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const config = await readConfig(client);
    const state = (
      await client.query("SELECT * FROM hoodball.indexer WHERE id=1")
    ).rows[0];
    const records = (
      await client.query(
        `SELECT h.address,h.balance,h.is_contract,(p.address IS NOT NULL) AS is_pool
         FROM hoodball.holders h LEFT JOIN hoodball.pools p ON p.address = h.address
         WHERE h.balance>0 ORDER BY h.balance DESC,h.address ASC`,
      )
    ).rows;
    const transfers = (
      await client.query(
        "SELECT t.*,c.kind FROM hoodball.transfers t LEFT JOIN hoodball.tx_classifications c ON c.tx_hash=t.tx_hash ORDER BY t.block_number DESC,t.log_index DESC LIMIT 30",
      )
    ).rows;
    await client.query("COMMIT");
    const { holders, eligibleBalance } = buildHolders(records, config);
    await getPrices();
    const ethUsd = ethUsdCached();
    const treasuryData = await getTreasurySnapshot(client, config);
    const gate = gateFor(
      config,
      state.phase,
      treasuryData.state?.isPons ? treasuryData.state.isNativeQuote : null,
    );
    const { draws, drawsPaid } = await getDrawsMeta(
      client,
      config,
      gate,
      ethUsd,
    );
    const recent = await listDraws(client, config, 0, 20, ethUsd);
    const payouts = await payoutActivity(client, 30);
    const market = await getMarket(
      client,
      config,
      state.total_supply === null || state.total_supply === undefined
        ? null
        : formatUnits(BigInt(state.total_supply), config.tokenDecimals),
    );
    const vaultEthWei = treasuryData.state?.vaultEthWei ?? null;
    const gasReserve = drawLimits.gasReserve();
    const potWei =
      vaultEthWei === null
        ? 0n
        : BigInt(vaultEthWei) > gasReserve
          ? BigInt(vaultEthWei) - gasReserve
          : 0n;
    const potEth = formatEther(potWei);
    const stale =
      !state.last_synced_at ||
      Date.now() - new Date(state.last_synced_at).getTime() > 60000;
    const chain: Snapshot["chain"] = {
      id: CHAIN_ID,
      name: "Robinhood Chain",
      explorerUrl: EXPLORER_URL,
      headBlock: state.head_block === null ? null : Number(state.head_block),
      indexedBlock:
        state.indexed_block === null ? null : Number(state.indexed_block),
      confirmations: CONFIRMATIONS,
      status: stale && state.phase === "live" ? "error" : state.phase,
      error:
        stale && state.phase === "live"
          ? "Holder data is stale; draws are paused until synchronization resumes."
          : state.error,
      lastSyncedAt: state.last_synced_at?.toISOString() ?? null,
    };
    const activity: Activity[] = [
      ...transfers.map((row) => ({
        id: `${row.tx_hash}:${row.log_index}`,
        type: (row.from_address === ZERO_ADDRESS
          ? "mint"
          : row.to_address === ZERO_ADDRESS
            ? "burn"
            : row.kind === "swap"
              ? "swap"
              : "transfer") as Activity["type"],
        txHash: row.tx_hash,
        from: row.from_address,
        to: row.to_address,
        amount: formatUnits(BigInt(row.amount), config.tokenDecimals),
        symbol: config.tokenSymbol,
        timestamp: row.timestamp.toISOString(),
        blockNumber: Number(row.block_number),
        explorerUrl: `${EXPLORER_URL}/tx/${row.tx_hash}`,
      })),
      ...payouts,
    ]
      .sort(
        (a, b) =>
          new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
      )
      .slice(0, 30);
    const version = snapshotVersion({
      config,
      indexer: {
        phase: state.phase,
        error: state.error ?? null,
        halted: Boolean(state.halted),
        totalSupply: state.total_supply ?? null,
        status: chain.status,
      },
      holders: records.map((row) => ({
        address: row.address,
        balance: row.balance,
        isContract: Boolean(row.is_contract),
        isPool: Boolean(row.is_pool),
      })),
      transferIds: transfers.map(
        (row) => `${row.tx_hash}:${row.log_index}:${row.kind ?? ""}`,
      ),
      draws: recent.items.map((draw) => ({
        id: draw.id,
        status: draw.status,
        revealed: draw.seed !== null,
      })),
      payouts: recent.items.flatMap((draw) =>
        draw.payouts.map((payout) => ({
          id: payout.id,
          status: payout.status,
          txHash: payout.txHash,
        })),
      ),
      drawsMeta: {
        gate: draws.gate,
        enabled: draws.enabled,
        intervalSeconds: draws.intervalSeconds,
        lastDrawAt: draws.lastDrawAt,
        totalDraws: draws.totalDraws,
        totalPaidWei: draws.totalPaidWei,
        pending: draws.pending,
      },
      jackpot: { potWei: potWei.toString(), vaultEthWei },
      market: {
        source: market.source,
        phase: market.phase,
        priceUsd:
          market.priceUsd === null
            ? null
            : Number(market.priceUsd.toPrecision(6)),
        progress:
          market.progress === null ? null : Number(market.progress.toFixed(3)),
        points: market.sparkline.length,
        error: market.error,
      },
      treasury: treasuryData.version,
    });
    const now = new Date().toISOString();
    const snapshot: Snapshot = {
      updatedAt: now,
      version,
      serverTime: now,
      config,
      chain,
      stats: {
        holders: holders.length,
        eligibleHolders: holders.filter((holder) => holder.eligible).length,
        eligibleBalance: formatUnits(eligibleBalance, config.tokenDecimals),
        totalSupply:
          state.total_supply === null || state.total_supply === undefined
            ? null
            : formatUnits(BigInt(state.total_supply), config.tokenDecimals),
        drawsPaid,
      },
      topHolders: holders.slice(0, 25),
      recentDraws: recent.items,
      activity,
      jackpot: {
        potWei: potWei.toString(),
        potEth,
        potUsd: ethUsd === null ? null : Number(potEth) * ethUsd,
        vaultEthWei,
        gasReserveWei: gasReserve.toString(),
        claimableCurveWei: treasuryData.state?.curveWei ?? null,
        claimableEscrowWei: treasuryData.state?.escrowWei ?? null,
        ethUsd,
      },
      draws,
      market,
      treasury: treasuryData.treasury,
      vault: {
        address: config.vaultAddress,
        explorerUrl: config.vaultAddress
          ? `${EXPLORER_URL}/address/${config.vaultAddress}`
          : null,
        ethWei: vaultEthWei,
        status: config.vaultAddress
          ? gate === "ok"
            ? drawStatusText()
            : GATE_REASONS[gate]
          : "Vault is awaiting configuration",
      },
    };
    shared.holders = holders;
    shared.eligibleBalance = eligibleBalance;
    shared.snapshot = snapshot;
  } catch (error) {
    if (client) await client.query("ROLLBACK").catch(() => {});
    console.error(
      "Snapshot refresh:",
      error instanceof Error ? error.message : "unknown",
    );
    if (shared.snapshot)
      shared.snapshot = {
        ...shared.snapshot,
        updatedAt: new Date().toISOString(),
        version: shortHash(`${shared.snapshot.version}:unavailable`),
        chain: {
          ...shared.snapshot.chain,
          status: "error",
          error:
            "Live data temporarily unavailable. Displaying the last verified snapshot.",
        },
      };
    else
      shared.snapshot = emptySnapshot(
        "Live data is connecting. No token or draws are active.",
      );
  } finally {
    client?.release();
    shared.refreshedAt = Date.now();
  }
  broadcast(previousVersion);
}

export async function refreshSnapshot() {
  if (!shared.refreshing)
    shared.refreshing = rebuild().finally(() => {
      shared.refreshing = null;
    });
  await shared.refreshing;
}

function broadcast(previousVersion: string | undefined) {
  const snapshot = shared.snapshot!;
  const changed = snapshot.version !== previousVersion;
  if (!changed && Date.now() - shared.broadcastAt < KEEPALIVE_MS) return;
  shared.broadcastAt = Date.now();
  for (const listener of [...shared.listeners])
    try {
      listener(snapshot);
    } catch (error) {
      console.error(
        "Snapshot listener:",
        error instanceof Error ? error.message : "unknown",
      );
    }
}

let payloadCache: { snapshot: Snapshot; text: string } | undefined;
export function snapshotEventPayload(snapshot: Snapshot) {
  if (payloadCache?.snapshot !== snapshot)
    payloadCache = {
      snapshot,
      text: `event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`,
    };
  return payloadCache.text;
}

export async function getSnapshot() {
  if (!shared.snapshot) await refreshSnapshot();
  else if (Date.now() - shared.refreshedAt > 5000)
    void refreshSnapshot().catch(() => {});
  return shared.snapshot!;
}

export function subscribeSnapshots(listener: (snapshot: Snapshot) => void) {
  shared.listeners.add(listener);
  return () => {
    shared.listeners.delete(listener);
  };
}

export async function getHolders(
  address: string | null,
  offset: number,
  limit: number,
) {
  await getSnapshot();
  if (address)
    return {
      holder:
        shared.holders.find(
          (holder) => holder.address.toLowerCase() === address.toLowerCase(),
        ) ?? null,
    };
  return {
    holders: shared.holders.slice(offset, offset + limit),
    total: shared.holders.length,
    offset,
    limit,
  };
}

export async function getOdds(address: string): Promise<OddsResult> {
  const snapshot = await getSnapshot();
  const normalized = address.toLowerCase();
  const holder =
    shared.holders.find(
      (entry) => entry.address.toLowerCase() === normalized,
    ) ?? null;
  const balance = holder ? BigInt(holder.balance) : 0n;
  const eligible = holder?.eligible ?? false;
  const chance = eligible
    ? odds(balance, shared.eligibleBalance)
    : { odds: 0, oneIn: null };
  return {
    address: normalized,
    balance: balance.toString(),
    balanceFormatted: formatUnits(balance, snapshot.config.tokenDecimals),
    eligible,
    exclusionReason: holder ? holder.exclusionReason : "No balance",
    odds: chance.odds,
    oneIn: chance.oneIn,
    eligibleHolders: snapshot.stats.eligibleHolders,
    nextDrawAt: snapshot.draws.nextDrawAt,
  };
}

export async function getRecentDraws(limit = 20): Promise<DrawRecord[]> {
  return (await getSnapshot()).recentDraws.slice(0, limit);
}

export function currentNextDrawAt(intervalSeconds: number) {
  return new Date(nextDrawAtMs(Date.now(), intervalSeconds)).toISOString();
}
