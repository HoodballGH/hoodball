import { randomBytes } from "node:crypto";
import type { PoolClient } from "pg";
import { formatEther, formatUnits, keccak256, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { estimateTransferGas, isUnderpricedRejection, suggestedGasPrice } from "./gas";
import { CHAIN_ID, CONFIRMATIONS, EXPLORER_URL } from "./chain";
import { readConfig } from "./db";
import { selectWinners, splitPot } from "./draw-selection";
import { exclusionReason, minBalanceWei } from "./eligibility";
import { describeLaunch } from "./pons";
import { assertChain, rpc, rpcNumber } from "./rpc";
import type {
  Activity,
  DrawGate,
  DrawRecord,
  DrawsMeta,
  DrawStatus,
  Payout,
  RuntimeConfig,
} from "./types";

export const PAYOUT_GAS = 21000n;
export const limits = {
  gasReserve: () =>
    BigInt(process.env.HOODBALL_GAS_RESERVE_WEI ?? "20000000000000000"),
  minPot: () => BigInt(process.env.HOODBALL_MIN_POT_WEI ?? "500000000000000"),
  maxGasPrice: () =>
    BigInt(process.env.HOODBALL_MAX_GAS_PRICE_WEI ?? "100000000000"),
  ethFloor: () =>
    BigInt(process.env.HOODBALL_MIN_ETH_WEI ?? "1000000000000000"),
};

let drawStatus = "Draws are awaiting the token configuration";
export function drawStatusText() {
  return drawStatus;
}
export function resetDrawStatusForTests() {
  drawStatus = "Draws are awaiting the token configuration";
}

/* ------------------------------------------------------------------ schedule */

export function cycleIdFor(nowMs: number, intervalSeconds: number) {
  return Math.floor(Math.floor(nowMs / 1000) / intervalSeconds);
}
export function scheduledAtMs(cycleId: number, intervalSeconds: number) {
  return cycleId * intervalSeconds * 1000;
}
/** Wall-clock aligned countdown target: ceil(now / interval) * interval. */
export function nextDrawAtMs(nowMs: number, intervalSeconds: number) {
  const seconds = Math.floor(nowMs / 1000);
  const next = Math.ceil(seconds / intervalSeconds) * intervalSeconds;
  return (next === seconds ? next + intervalSeconds : next) * 1000;
}
/**
 * The cycle that is owed a draw right now, or null when the current boundary is
 * already recorded. Only ever the latest missed cycle: a server that was down
 * for six hours runs one draw on recovery, not six.
 */
export function dueCycle(
  nowMs: number,
  intervalSeconds: number,
  lastCycleId: number | null,
) {
  const current = cycleIdFor(nowMs, intervalSeconds);
  if (lastCycleId !== null && lastCycleId >= current) return null;
  return current;
}

/* ---------------------------------------------------------------------- gate */

export type GateInput = {
  hasToken: boolean;
  indexerLive: boolean;
  moneyEnabled: boolean;
  hasVaultKey: boolean;
  vaultMatches: boolean;
  quoteSupported: boolean;
  enabled: boolean;
};
export function drawGate(input: GateInput): DrawGate {
  if (!input.hasToken) return "no_token";
  if (!input.indexerLive) return "indexer_not_live";
  if (!input.moneyEnabled) return "money_disabled";
  if (!input.hasVaultKey) return "no_vault_key";
  if (!input.vaultMatches) return "vault_mismatch";
  if (!input.quoteSupported) return "unsupported_quote";
  if (!input.enabled) return "paused";
  return "ok";
}
export const GATE_REASONS: Record<DrawGate, string> = {
  no_token: "No token is configured yet; draws start once the contract is set",
  indexer_not_live: "Waiting for the holder index to reach the chain head",
  money_disabled: "Money execution is disabled in the deployment environment",
  no_vault_key: "The vault signing key has not been configured",
  vault_mismatch:
    "The vault signer does not match the configured vault address",
  unsupported_quote:
    "This launch is not quoted in ETH; Hoodball pays native ETH only",
  paused: "Draws are paused",
  ok: "Draws are running",
};

const VAULT_KEY_PATTERN = /^0x[\da-f]{64}$/i;
let signerCache: { key: string; address: string } | null = null;
export function vaultSignerAddress(): string | null {
  const key = process.env.HOODBALL_VAULT_PRIVATE_KEY;
  if (!key || !VAULT_KEY_PATTERN.test(key)) return null;
  if (signerCache?.key !== key)
    signerCache = {
      key,
      address: privateKeyToAccount(key as Hex).address.toLowerCase(),
    };
  return signerCache.address;
}
/**
 * The payout signer IS the vault. When the operator supplies only the key, the
 * vault address is derived from it once so go-live needs nothing else; a
 * configured address that differs is left alone and surfaces as vault_mismatch.
 */
let vaultApplied: string | null = null;
export async function ensureVaultFromKey(client: PoolClient) {
  const signer = vaultSignerAddress();
  if (!signer || vaultApplied === signer) return;
  const config = await readConfig(client);
  if (config.vaultAddress) {
    vaultApplied = signer;
    return;
  }
  if (config.tokenAddress && signer === config.tokenAddress.toLowerCase())
    return;
  await client.query("BEGIN");
  try {
    await client.query(
      "UPDATE hoodball.runtime_config SET config=$1,updated_at=now() WHERE id=1",
      [JSON.stringify({ ...config, vaultAddress: signer })],
    );
    await client.query(
      "INSERT INTO hoodball.config_audit(changed_fields) VALUES($1)",
      [["vaultAddress"]],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
  vaultApplied = signer;
  console.log(`Vault address derived from the signing key: ${signer}`);
}
export function resetVaultDerivationForTests() {
  vaultApplied = null;
}

export function quoteSupported(launch: {
  launched: boolean;
  isNativeQuote: boolean;
}) {
  return !launch.launched || launch.isNativeQuote;
}

export function gateFor(
  config: RuntimeConfig,
  chainStatus: string,
  nativeQuote: boolean | null,
): DrawGate {
  const signer = vaultSignerAddress();
  return drawGate({
    hasToken: Boolean(config.tokenAddress),
    indexerLive: chainStatus === "live",
    moneyEnabled: process.env.MONEY_ENABLED === "true",
    hasVaultKey: signer !== null,
    vaultMatches:
      signer !== null && signer === config.vaultAddress?.toLowerCase(),
    quoteSupported: nativeQuote !== false,
    enabled: config.drawsEnabled,
  });
}

/* ------------------------------------------------------------------ readers */

type DrawRow = {
  id: string;
  cycle_id: string;
  scheduled_at: Date;
  executed_at: Date | null;
  snapshot_block: string | null;
  status: DrawStatus;
  pot_wei: string;
  gas_reserve_wei: string;
  eligible_count: number;
  eligible_balance: string;
  seed_hash: string | null;
  seed: string | null;
  revealed_at: Date | null;
  skip_reason: string | null;
};
type PayoutRow = {
  id: string;
  draw_id: string;
  recipient: string;
  amount_wei: string;
  balance_wei: string;
  odds_bps: number;
  status: string;
  nonce: string | null;
  tx_hash: Hex | null;
  raw_tx: Hex | null;
  block_number: string | null;
  reason: string | null;
  created_at: Date;
  updated_at: Date;
  confirmed_at: Date | null;
};

function formatPayout(
  row: PayoutRow,
  decimals: number,
  ethUsd: number | null,
): Payout {
  const amountEth = formatEther(BigInt(row.amount_wei));
  return {
    id: row.id,
    recipient: row.recipient,
    amountWei: row.amount_wei,
    amountEth,
    amountUsd: ethUsd === null ? null : Number(amountEth) * ethUsd,
    balanceFormatted: formatUnits(BigInt(row.balance_wei), decimals),
    oddsPct: row.odds_bps / 100,
    status: row.status,
    txHash: row.tx_hash,
    explorerUrl: row.tx_hash ? `${EXPLORER_URL}/tx/${row.tx_hash}` : null,
    confirmedAt: row.confirmed_at
      ? new Date(row.confirmed_at).toISOString()
      : null,
  };
}

function formatDraw(
  row: DrawRow,
  payouts: Payout[],
  ethUsd: number | null,
): DrawRecord {
  const potEth = formatEther(BigInt(row.pot_wei));
  return {
    id: row.id,
    cycleId: Number(row.cycle_id),
    scheduledAt: new Date(row.scheduled_at).toISOString(),
    executedAt: row.executed_at
      ? new Date(row.executed_at).toISOString()
      : null,
    snapshotBlock:
      row.snapshot_block === null ? null : Number(row.snapshot_block),
    status: row.status,
    potWei: row.pot_wei,
    potEth,
    potUsd: ethUsd === null ? null : Number(potEth) * ethUsd,
    eligibleHolders: row.eligible_count,
    seedHash: row.seed_hash,
    seed: row.revealed_at ? row.seed : null,
    skipReason: row.skip_reason,
    payouts,
  };
}

export async function listDraws(
  client: PoolClient,
  config: RuntimeConfig,
  offset: number,
  limit: number,
  ethUsd: number | null = null,
): Promise<{
  total: number;
  offset: number;
  limit: number;
  items: DrawRecord[];
}> {
  const rows = (
    await client.query<DrawRow>(
      "SELECT * FROM hoodball.draws ORDER BY cycle_id DESC LIMIT $1 OFFSET $2",
      [limit, offset],
    )
  ).rows;
  const total = Number(
    (await client.query("SELECT count(*)::text AS count FROM hoodball.draws"))
      .rows[0].count,
  );
  const payouts = rows.length
    ? (
        await client.query<PayoutRow>(
          "SELECT * FROM hoodball.draw_payouts WHERE draw_id = ANY($1::text[]) ORDER BY amount_wei DESC,id ASC",
          [rows.map((row) => row.id)],
        )
      ).rows
    : [];
  const byDraw = new Map<string, Payout[]>();
  for (const row of payouts) {
    const list = byDraw.get(row.draw_id) ?? [];
    list.push(formatPayout(row, config.tokenDecimals, ethUsd));
    byDraw.set(row.draw_id, list);
  }
  return {
    total,
    offset,
    limit,
    items: rows.map((row) => formatDraw(row, byDraw.get(row.id) ?? [], ethUsd)),
  };
}

export function emptyDrawsMeta(
  intervalSeconds: number,
  gate: DrawGate = "no_token",
  enabled = true,
): DrawsMeta {
  return {
    enabled,
    gate,
    intervalSeconds,
    nextDrawAt: new Date(
      nextDrawAtMs(Date.now(), intervalSeconds),
    ).toISOString(),
    lastDrawAt: null,
    totalDraws: 0,
    totalPaidWei: "0",
    totalPaidEth: "0",
    totalPaidUsd: null,
    pending: { queued: 0, signed: 0, submitted: 0, review: 0 },
  };
}

export async function getDrawsMeta(
  client: PoolClient,
  config: RuntimeConfig,
  gate: DrawGate,
  ethUsd: number | null,
): Promise<{ draws: DrawsMeta; drawsPaid: number }> {
  const summary = (
    await client.query(
      "SELECT count(*)::int AS total, max(executed_at) AS last_at, count(*) FILTER (WHERE status='paid')::int AS paid FROM hoodball.draws",
    )
  ).rows[0];
  const groups = (
    await client.query(
      "SELECT status,count(*)::int AS n,COALESCE(sum(amount_wei),0)::text AS total FROM hoodball.draw_payouts GROUP BY status",
    )
  ).rows;
  const meta = emptyDrawsMeta(
    config.drawIntervalSeconds,
    gate,
    config.drawsEnabled,
  );
  meta.totalDraws = summary.total;
  meta.lastDrawAt = summary.last_at
    ? new Date(summary.last_at).toISOString()
    : null;
  let paidWei = 0n;
  for (const group of groups) {
    if (group.status === "confirmed") paidWei += BigInt(group.total);
    else if (group.status in meta.pending)
      meta.pending[group.status as keyof DrawsMeta["pending"]] += group.n;
  }
  meta.totalPaidWei = paidWei.toString();
  meta.totalPaidEth = formatEther(paidWei);
  meta.totalPaidUsd =
    ethUsd === null ? null : Number(meta.totalPaidEth) * ethUsd;
  return { draws: meta, drawsPaid: summary.paid };
}

export async function payoutActivity(
  client: PoolClient,
  limit: number,
): Promise<Activity[]> {
  const rows = (
    await client.query<PayoutRow & { vault: string | null }>(
      "SELECT * FROM hoodball.draw_payouts WHERE status='confirmed' AND tx_hash IS NOT NULL ORDER BY confirmed_at DESC NULLS LAST,id DESC LIMIT $1",
      [limit],
    )
  ).rows;
  const config = await readConfig(client);
  return rows.map((row) => ({
    id: `payout:${row.id}`,
    type: "payout" as const,
    txHash: row.tx_hash!,
    from: config.vaultAddress ?? "",
    to: row.recipient,
    amount: formatEther(BigInt(row.amount_wei)),
    symbol: "ETH",
    timestamp: new Date(row.confirmed_at ?? row.updated_at).toISOString(),
    blockNumber: row.block_number === null ? 0 : Number(row.block_number),
    explorerUrl: `${EXPLORER_URL}/tx/${row.tx_hash}`,
  }));
}

/* ------------------------------------------------------------------- engine */

type Receipt = {
  status: Hex;
  blockNumber: Hex;
  blockHash: Hex;
  to: string | null;
};
type Transaction = { from: string; to: string | null; value: Hex };
const same = (a: string | null | undefined, b: string | null | undefined) =>
  !!a && !!b && a.toLowerCase() === b.toLowerCase();

export async function eligibleHolders(
  client: PoolClient,
  config: RuntimeConfig,
) {
  const rows = (
    await client.query(
      `SELECT h.address,h.balance,h.is_contract,(p.address IS NOT NULL) AS is_pool
       FROM hoodball.holders h LEFT JOIN hoodball.pools p ON p.address = h.address
       WHERE h.balance > 0 ORDER BY h.address`,
    )
  ).rows;
  const minimum = minBalanceWei(config);
  const holders: { address: string; balance: bigint }[] = [];
  let total = 0n;
  for (const row of rows) {
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
    if (reason !== null) continue;
    holders.push({ address: row.address, balance });
    total += balance;
  }
  return { holders, total };
}

async function reconcile(
  client: PoolClient,
  config: RuntimeConfig,
  head: number,
) {
  const pending = (
    await client.query<PayoutRow>(
      "SELECT * FROM hoodball.draw_payouts WHERE status IN ('signed','submitted') ORDER BY nonce LIMIT 100",
    )
  ).rows;
  for (const payout of pending) {
    if (!payout.tx_hash)
      throw new Error("Signed payout missing a transaction hash");
    const receipt = await rpc<Receipt | null>("eth_getTransactionReceipt", [
      payout.tx_hash,
    ]);
    if (!receipt || head - rpcNumber(receipt.blockNumber) < CONFIRMATIONS)
      continue;
    const block = await rpc<{ hash: string }>("eth_getBlockByNumber", [
      receipt.blockNumber,
      false,
    ]);
    if (!same(block.hash, receipt.blockHash))
      throw new Error("Payout receipt is not canonical");
    const transaction = await rpc<Transaction | null>(
      "eth_getTransactionByHash",
      [payout.tx_hash],
    );
    const exact =
      /^0x0*1$/.test(receipt.status) &&
      same(receipt.to, payout.recipient) &&
      !!transaction &&
      same(transaction.to, payout.recipient) &&
      same(transaction.from, config.vaultAddress) &&
      BigInt(transaction.value) === BigInt(payout.amount_wei);
    const status = /^0x0+$/.test(receipt.status)
      ? "failed"
      : exact
        ? "confirmed"
        : "review";
    await client.query(
      `UPDATE hoodball.draw_payouts SET status=$2,block_number=$3,reason=$4,updated_at=now(),
       confirmed_at=CASE WHEN $2='confirmed' THEN now() ELSE confirmed_at END WHERE id=$1`,
      [
        payout.id,
        status,
        rpcNumber(receipt.blockNumber),
        status === "review"
          ? "Successful transaction did not match the exact recipient and amount"
          : status === "failed"
            ? "Transaction reverted on chain"
            : null,
      ],
    );
  }
}

/** Finalizes draws whose payouts have all settled and reveals their seed. */
export async function settleDraws(client: PoolClient) {
  await client.query(
    `UPDATE hoodball.draws d SET status='review',updated_at=now()
     WHERE d.status='scheduled' AND EXISTS(
       SELECT 1 FROM hoodball.draw_payouts p WHERE p.draw_id=d.id AND p.status='review')`,
  );
  await client.query(
    `UPDATE hoodball.draws d SET
       status = CASE WHEN EXISTS(SELECT 1 FROM hoodball.draw_payouts p WHERE p.draw_id=d.id AND p.status <> 'confirmed')
                     THEN 'review' ELSE 'paid' END,
       revealed_at = now(), updated_at = now()
     WHERE d.status IN ('scheduled','review') AND d.revealed_at IS NULL
       AND EXISTS(SELECT 1 FROM hoodball.draw_payouts p WHERE p.draw_id=d.id)
       AND NOT EXISTS(SELECT 1 FROM hoodball.draw_payouts p WHERE p.draw_id=d.id
                      AND p.status IN ('queued','signed','submitted','review'))`,
  );
}

export async function createDraw(
  client: PoolClient,
  config: RuntimeConfig,
  cycleId: number,
  snapshotBlock: number,
  vaultEthWei: bigint,
): Promise<"paid" | "rolled_over" | "skipped" | "duplicate"> {
  const gasReserve = limits.gasReserve();
  const pot = vaultEthWei > gasReserve ? vaultEthWei - gasReserve : 0n;
  const scheduledAt = new Date(
    scheduledAtMs(cycleId, config.drawIntervalSeconds),
  ).toISOString();
  const { holders, total } = await eligibleHolders(client, config);
  const id = `${cycleId}:${randomBytes(8).toString("hex")}`;
  const insert = async (
    status: DrawStatus,
    potWei: bigint,
    seedHash: string | null,
    seed: string | null,
    skipReason: string | null,
  ) =>
    client.query(
      `INSERT INTO hoodball.draws(id,cycle_id,scheduled_at,executed_at,snapshot_block,status,pot_wei,gas_reserve_wei,
        eligible_count,eligible_balance,seed_hash,seed,skip_reason)
       VALUES($1,$2,$3,now(),$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT(cycle_id) DO NOTHING`,
      [
        id,
        cycleId,
        scheduledAt,
        snapshotBlock,
        status,
        potWei.toString(),
        gasReserve.toString(),
        holders.length,
        total.toString(),
        seedHash,
        seed,
        skipReason,
      ],
    );
  if (pot < limits.minPot()) {
    const result = await insert(
      "rolled_over",
      pot,
      null,
      null,
      "Pot is below the minimum; it rolls over into the next draw",
    );
    if (!result.rowCount) return "duplicate";
    drawStatus = "Pot below the minimum; it rolled over to the next draw";
    return "rolled_over";
  }
  if (!holders.length) {
    const result = await insert(
      "skipped",
      pot,
      null,
      null,
      "No eligible holders at the snapshot block",
    );
    if (!result.rowCount) return "duplicate";
    drawStatus = "No eligible holders; the pot rolls over";
    return "skipped";
  }
  const winnerCount = Math.max(
    1,
    Math.min(config.winnersPerDraw, 10, holders.length),
  );
  const seed = `0x${randomBytes(32).toString("hex")}` as Hex;
  const seedHash = keccak256(seed);
  const winners = selectWinners(seed, holders, winnerCount);
  const amounts = splitPot(pot, winners.length);
  if (amounts.length !== winners.length)
    throw new Error("Pot split did not cover every winner");
  await client.query("BEGIN");
  try {
    const result = await insert("scheduled", pot, seedHash, seed, null);
    if (!result.rowCount) {
      await client.query("ROLLBACK");
      return "duplicate";
    }
    for (let i = 0; i < winners.length; i++) {
      const oddsBps =
        total > 0n ? Number((winners[i].balance * 10000n) / total) : 0;
      await client.query(
        `INSERT INTO hoodball.draw_payouts(id,draw_id,recipient,amount_wei,balance_wei,odds_bps,status)
         VALUES($1,$2,$3,$4,$5,$6,'queued')`,
        [
          `${id}:${winners[i].address}`,
          id,
          winners[i].address,
          amounts[i].toString(),
          winners[i].balance.toString(),
          oddsBps,
        ],
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
  drawStatus = `Draw ${cycleId} selected ${winners.length} winner${winners.length === 1 ? "" : "s"} for ${formatEther(pot)} ETH`;
  return "paid";
}

type Reprice = {
  account: ReturnType<typeof privateKeyToAccount>;
  recipient: string;
  amount: bigint;
  nonce: bigint;
};

// Re-signs the identical transfer (same nonce, recipient and amount) with a
// higher gas price when the network refused the original as underpriced and
// never saw it. The nonce guarantees at most one of the two can ever mine.
async function reprice(
  client: PoolClient,
  payout: { id: string; tx_hash: Hex },
  r: Reprice,
) {
  const latest = BigInt(
    await rpc<Hex>("eth_getTransactionCount", [r.account.address, "latest"]),
  );
  if (latest !== r.nonce) return null;
  const gasPrice = await suggestedGasPrice(limits.maxGasPrice());
  if (gasPrice > limits.maxGasPrice()) return null;
  const gas = await estimateTransferGas(r.account.address, r.recipient, r.amount);
  const raw = await r.account.signTransaction({
    chainId: CHAIN_ID,
    to: r.recipient as Hex,
    value: r.amount,
    gas,
    gasPrice,
    nonce: Number(r.nonce),
    type: "legacy",
  });
  const hash = keccak256(raw);
  const stored = await client.query(
    "UPDATE hoodball.draw_payouts SET raw_tx=$2,tx_hash=$3,reason=$4,updated_at=now() WHERE id=$1 AND status='signed' AND tx_hash=$5",
    [payout.id, raw, hash, `Repriced to ${gasPrice} wei gas after an underpriced rejection`, payout.tx_hash],
  );
  if (!stored.rowCount) return null;
  return { raw_tx: raw, tx_hash: hash };
}

async function broadcast(
  client: PoolClient,
  payout: { id: string; raw_tx: Hex; tx_hash: Hex },
  r?: Reprice,
): Promise<boolean> {
  let rejection: unknown;
  try {
    const hash = await rpc<Hex>("eth_sendRawTransaction", [payout.raw_tx]);
    if (!same(hash, payout.tx_hash)) throw new Error("Broadcast hash mismatch");
    await client.query(
      "UPDATE hoodball.draw_payouts SET status='submitted',updated_at=now() WHERE id=$1",
      [payout.id],
    );
    return true;
  } catch (error) {
    rejection = error;
  }
  const known = await rpc<{ hash: Hex } | null>("eth_getTransactionByHash", [
    payout.tx_hash,
  ]);
  if (known) {
    await client.query(
      "UPDATE hoodball.draw_payouts SET status='submitted',updated_at=now() WHERE id=$1",
      [payout.id],
    );
    return true;
  }
  if (r && isUnderpricedRejection(rejection)) {
    const next = await reprice(client, payout, r);
    if (next) return broadcast(client, { id: payout.id, ...next });
  }
  console.error(
    `Payout ${payout.id} broadcast rejected: ${rejection instanceof Error ? rejection.message : "unknown"}`,
  );
  drawStatus =
    "A signed payout is awaiting network acceptance; its exact transaction is retained";
  return false;
}

export async function runDraws(client: PoolClient) {
  const config = await readConfig(client);
  if (!config.tokenAddress) {
    drawStatus = GATE_REASONS.no_token;
    return;
  }
  await assertChain();
  const head = rpcNumber(await rpc<Hex>("eth_blockNumber"));
  await reconcile(client, config, head);
  await settleDraws(client);
  const launch = await describeLaunch(config.tokenAddress);
  const state = (
    await client.query("SELECT * FROM hoodball.indexer WHERE id=1")
  ).rows[0];
  const stale =
    !state.last_synced_at ||
    Date.now() - new Date(state.last_synced_at).getTime() > 60000;
  const gate = drawGate({
    hasToken: true,
    indexerLive: state.phase === "live" && !state.halted && !stale,
    moneyEnabled: process.env.MONEY_ENABLED === "true",
    hasVaultKey: vaultSignerAddress() !== null,
    vaultMatches:
      vaultSignerAddress() !== null &&
      vaultSignerAddress() === config.vaultAddress?.toLowerCase(),
    quoteSupported: quoteSupported(launch),
    enabled: config.drawsEnabled,
  });
  if (gate !== "ok") {
    drawStatus = GATE_REASONS[gate];
    return;
  }
  const account = privateKeyToAccount(
    process.env.HOODBALL_VAULT_PRIVATE_KEY as Hex,
  );
  const lock = await client.query(
    "SELECT pg_try_advisory_lock(hashtextextended($1,4663)) AS acquired",
    [account.address.toLowerCase()],
  );
  if (!lock.rows[0].acquired) {
    drawStatus = "Waiting for the treasury keeper to release the vault";
    return;
  }
  try {
    const underReview = !!(
      await client.query(
        "SELECT 1 FROM hoodball.draw_payouts WHERE status='review' LIMIT 1",
      )
    ).rowCount;
    const pending = (
      await client.query<PayoutRow>(
        "SELECT * FROM hoodball.draw_payouts WHERE status IN ('signed','submitted') ORDER BY nonce LIMIT 100",
      )
    ).rows;
    if (pending.length) {
      const latestNonce = BigInt(
        await rpc<Hex>("eth_getTransactionCount", [account.address, "latest"]),
      );
      for (const payout of pending) {
        if (
          await rpc<Receipt | null>("eth_getTransactionReceipt", [
            payout.tx_hash,
          ])
        )
          continue;
        const known = await rpc<{ hash: Hex } | null>(
          "eth_getTransactionByHash",
          [payout.tx_hash],
        );
        if (payout.nonce !== null && latestNonce > BigInt(payout.nonce)) {
          if (!known) {
            // The retained bytes can never mine (nonce used by another mined
            // transaction) and the network never saw them: sign again fresh.
            await client.query(
              "UPDATE hoodball.draw_payouts SET status='queued',nonce=NULL,raw_tx=NULL,tx_hash=NULL,reason='Requeued: vault nonce was consumed externally before broadcast',updated_at=now() WHERE id=$1",
              [payout.id],
            );
            await client.query(
              "UPDATE hoodball.draws SET status='scheduled',updated_at=now() WHERE id=$1 AND status='review'",
              [payout.draw_id],
            );
            console.error(`Payout ${payout.id} requeued: vault nonce consumed externally`);
            continue;
          }
          await client.query(
            "UPDATE hoodball.draw_payouts SET status='review',reason='Vault nonce consumed by another transaction',updated_at=now() WHERE id=$1",
            [payout.id],
          );
          drawStatus = "A vault nonce conflict needs operator review";
          return;
        }
        if (
          !known &&
          !(await broadcast(
            client,
            { id: payout.id, raw_tx: payout.raw_tx!, tx_hash: payout.tx_hash! },
            { account, recipient: payout.recipient, amount: BigInt(payout.amount_wei), nonce: BigInt(payout.nonce!) },
          ))
        )
          return;
        if (known && payout.status === "signed")
          await client.query(
            "UPDATE hoodball.draw_payouts SET status='submitted',updated_at=now() WHERE id=$1",
            [payout.id],
          );
      }
      const stillPending = (
        await client.query(
          "SELECT count(*)::int AS n FROM hoodball.draw_payouts WHERE status IN ('signed','submitted')",
        )
      ).rows[0].n as number;
      if (stillPending) {
        drawStatus = `Waiting for ${stillPending} payout${stillPending === 1 ? "" : "s"} to confirm`;
        return;
      }
    }
    if (underReview) {
      drawStatus = "A payout needs operator review; new draws are paused";
      return;
    }
    if (
      (
        await client.query(
          "SELECT 1 FROM hoodball.treasury_ops WHERE status IN ('signed','submitted') LIMIT 1",
        )
      ).rowCount
    ) {
      drawStatus =
        "Waiting for treasury transactions to confirm before the draw";
      return;
    }
    const committed = BigInt(
      (
        await client.query(
          "SELECT coalesce(sum(amount_wei),0)::text AS total, count(*)::int AS n FROM hoodball.draw_payouts WHERE status IN ('queued','signed','submitted')",
        )
      ).rows[0].total,
    );
    const committedCount = (
      await client.query(
        "SELECT count(*)::int AS n FROM hoodball.draw_payouts WHERE status='queued'",
      )
    ).rows[0].n as number;
    const rawVaultEthWei = BigInt(
      await rpc<Hex>("eth_getBalance", [account.address, "latest"]),
    );
    const vaultEthWei = rawVaultEthWei > committed ? rawVaultEthWei - committed : 0n;
    const last = (
      await client.query(
        "SELECT cycle_id FROM hoodball.draws ORDER BY cycle_id DESC LIMIT 1",
      )
    ).rows[0];
    const due = dueCycle(
      Date.now(),
      config.drawIntervalSeconds,
      last ? Number(last.cycle_id) : null,
    );
    if (due !== null && committedCount === 0)
      await createDraw(
        client,
        config,
        due,
        Number(state.indexed_block),
        vaultEthWei,
      );
    const queued = (
      await client.query<PayoutRow>(
        "SELECT * FROM hoodball.draw_payouts WHERE status='queued' ORDER BY created_at,id LIMIT 10",
      )
    ).rows;
    if (!queued.length) {
      if (due === null)
        drawStatus = `Next draw at ${new Date(nextDrawAtMs(Date.now(), config.drawIntervalSeconds)).toISOString()}`;
      return;
    }
    const latestNonce = BigInt(
      await rpc<Hex>("eth_getTransactionCount", [account.address, "latest"]),
    );
    let nonce = BigInt(
      await rpc<Hex>("eth_getTransactionCount", [account.address, "pending"]),
    );
    if (latestNonce !== nonce) {
      drawStatus = "Waiting for other vault transactions to confirm";
      return;
    }
    const gasPrice = await suggestedGasPrice(limits.maxGasPrice());
    if (gasPrice > limits.maxGasPrice()) {
      drawStatus = "Network fee exceeds the configured limit";
      return;
    }
    let balance = rawVaultEthWei;
    for (const payout of queued) {
      const amount = BigInt(payout.amount_wei);
      const gas = await estimateTransferGas(account.address, payout.recipient, amount);
      const cost = amount + gas * gasPrice;
      if (balance - cost < limits.ethFloor()) {
        drawStatus = "Vault needs ETH to cover the payout and its fee";
        return;
      }
      if (nonce > BigInt(Number.MAX_SAFE_INTEGER))
        throw new Error("Unsupported vault nonce");
      const raw = await account.signTransaction({
        chainId: CHAIN_ID,
        to: payout.recipient as Hex,
        value: amount,
        gas,
        gasPrice,
        nonce: Number(nonce),
        type: "legacy",
      });
      const hash = keccak256(raw);
      const stored = await client.query(
        "UPDATE hoodball.draw_payouts SET status='signed',nonce=$2,raw_tx=$3,tx_hash=$4,updated_at=now() WHERE id=$1 AND status='queued'",
        [payout.id, nonce.toString(), raw, hash],
      );
      if (!stored.rowCount) return;
      if (
        !(await broadcast(
          client,
          { id: payout.id, raw_tx: raw, tx_hash: hash },
          { account, recipient: payout.recipient, amount, nonce },
        ))
      )
        return;
      balance -= cost;
      nonce++;
    }
    drawStatus = "Payouts are being confirmed on chain";
  } finally {
    await client.query("SELECT pg_advisory_unlock(hashtextextended($1,4663))", [
      account.address.toLowerCase(),
    ]);
  }
}
