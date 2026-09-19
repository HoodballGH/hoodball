import { loadEnvConfig } from "@next/env";
import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { keccak256, type Hex } from "viem";
import { ZERO_ADDRESS } from "../lib/chain";
import { ensureSchema, pool } from "../lib/db";
import { selectWinners, splitPot } from "../lib/draw-selection";
import type { RuntimeConfig } from "../lib/types";
loadEnvConfig(process.cwd());

const TOKEN = "0x1111111111111111111111111111111111111111";
const VAULT = "0x9999999999999999999999999999999999999999";
const CURVE = "0xa486206dc799a65559324bf93b2ccef870ed8fc6";
const INDEXED_BLOCK = 250000;
const HEAD_BLOCK = 250012;
const BLOCK_SECONDS = 12;
const HOUR = 3600;
const HOLDER_COUNT = 400;
const CONTRACT_COUNT = 12;
const TRANSFER_COUNT = 700;
const DRAW_COUNT = 12;

function assertLocalTarget() {
  const url = process.env.DATABASE_URL;
  if (!url)
    throw new Error(
      "DATABASE_URL is required (example: postgresql://user@127.0.0.1:5432/hoodball_dev)",
    );
  const host = new URL(url).hostname;
  if (!["localhost", "127.0.0.1"].includes(host))
    throw new Error(`Refusing to seed a non-local database host (${host})`);
  if (process.env.HOODBALL_ALLOW_FIXTURE !== "true")
    throw new Error(
      "Set HOODBALL_ALLOW_FIXTURE=true to confirm this database may be wiped and replaced with fixture data",
    );
}

function createRandom(seed: number) {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (min: number, max: number) =>
    min + Math.floor(next() * (max - min + 1));
  const hex = (bytes: number) =>
    Array.from({ length: bytes }, () =>
      int(0, 255).toString(16).padStart(2, "0"),
    ).join("");
  const normal = () =>
    Math.sqrt(-2 * Math.log(1 - next())) * Math.cos(2 * Math.PI * next());
  const pick = <T>(items: T[]) => items[int(0, items.length - 1)];
  const shuffle = <T>(items: T[]) => {
    const copy = [...items];
    for (let i = copy.length - 1; i > 0; i--) {
      const j = int(0, i);
      [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy;
  };
  return { next, int, hex, normal, pick, shuffle };
}

const random = createRandom(0x484f4f44);
const sha256 = (text: string) =>
  createHash("sha256").update(text).digest("hex");
const tokens = (amount: number) =>
  BigInt(Math.max(1, Math.round(amount * 1e6))) * 10n ** 12n;
const wei = (eth: number) => BigInt(Math.round(eth * 1e12)) * 10n ** 6n;

const config: RuntimeConfig = {
  tokenAddress: TOKEN,
  startBlock: 1000,
  tokenSymbol: "HOODBALL",
  tokenName: "Hoodball",
  tokenDecimals: 18,
  vaultAddress: VAULT,
  excludedAddresses: [],
  drawsEnabled: true,
  drawIntervalSeconds: HOUR,
  winnersPerDraw: 1,
  minBalance: "0",
  twitterUrl: null,
};

type HolderRow = {
  address: string;
  balance: bigint;
  is_contract: boolean;
  first_seen_at: Date;
};

function buildHolders(now: number) {
  const holders: HolderRow[] = [];
  for (let i = 0; i < HOLDER_COUNT; i++)
    holders.push({
      address: `0x${random.hex(20)}`,
      balance: tokens(Math.exp(Math.log(2000) + 1.6 * random.normal())),
      is_contract: false,
      first_seen_at: new Date(now - random.int(600, 160 * 86400) * 1000),
    });
  const contractIndexes = random
    .shuffle(holders.map((_, i) => i))
    .slice(0, CONTRACT_COUNT);
  for (const index of contractIndexes) holders[index].is_contract = true;
  const poolAddress = holders[contractIndexes[0]].address;
  const circulating = holders.reduce((sum, holder) => sum + holder.balance, 0n);
  holders[contractIndexes[0]].balance = (circulating * 12n) / 100n;
  holders.push({
    address: VAULT,
    balance: tokens(25000),
    is_contract: false,
    first_seen_at: new Date(now - 45 * 86400 * 1000),
  });
  return { holders, poolAddress };
}

function buildTransfers(
  now: number,
  holders: HolderRow[],
  poolAddress: string,
) {
  const wallets = holders.filter(
    (holder) => !holder.is_contract && holder.address !== VAULT,
  );
  const ages = Array.from(
    { length: TRANSFER_COUNT },
    () => 60 + Math.floor(random.next() ** 1.4 * (30 * 86400 - 60)),
  ).sort((a, b) => a - b);
  const seen = new Set<string>();
  return ages.map((age) => {
    let txHash: string;
    do txHash = `0x${random.hex(32)}`;
    while (seen.has(txHash));
    seen.add(txHash);
    const blockNumber = INDEXED_BLOCK - Math.floor(age / BLOCK_SECONDS);
    const roll = random.next();
    const wallet = random.pick(wallets);
    let from: string;
    let to: string;
    let amount: bigint;
    let swap = false;
    if (roll < 0.15) {
      from = ZERO_ADDRESS;
      to = wallet.address;
      amount = (wallet.balance * BigInt(random.int(5, 60))) / 100n;
    } else if (roll < 0.17) {
      from = wallet.address;
      to = ZERO_ADDRESS;
      amount = (wallet.balance * BigInt(random.int(1, 20))) / 100n;
    } else if (roll < 0.32) {
      from = poolAddress;
      to = wallet.address;
      amount = (wallet.balance * BigInt(random.int(2, 40))) / 100n;
      swap = true;
    } else if (roll < 0.46) {
      from = wallet.address;
      to = poolAddress;
      amount = (wallet.balance * BigInt(random.int(2, 35))) / 100n;
      swap = true;
    } else {
      let other = random.pick(wallets);
      while (other.address === wallet.address) other = random.pick(wallets);
      from = wallet.address;
      to = other.address;
      amount = (wallet.balance * BigInt(random.int(1, 45))) / 100n;
    }
    if (amount <= 0n) amount = 10n ** 15n;
    return {
      tx_hash: txHash,
      log_index: swap ? random.int(2, 7) : random.int(0, 2),
      block_number: blockNumber,
      block_hash: `0x${sha256(`block:${blockNumber}`)}`,
      from_address: from,
      to_address: to,
      amount: amount.toString(),
      timestamp: new Date(now - age * 1000),
      swap,
    };
  });
}

function buildDraws(now: number, holders: HolderRow[], poolAddress: string) {
  const eligible = holders
    .filter(
      (holder) =>
        !holder.is_contract &&
        holder.address !== VAULT &&
        holder.address !== poolAddress &&
        holder.balance > 0n,
    )
    .map((holder) => ({ address: holder.address, balance: holder.balance }));
  const total = eligible.reduce((sum, holder) => sum + holder.balance, 0n);
  const currentCycle = Math.floor(now / 1000 / HOUR);
  const draws: Record<string, unknown>[] = [];
  const payouts: Record<string, unknown>[] = [];
  for (let i = DRAW_COUNT; i >= 1; i--) {
    const cycleId = currentCycle - i;
    const scheduledAt = new Date(cycleId * HOUR * 1000);
    const executedAt = new Date(
      scheduledAt.getTime() + random.int(3, 40) * 1000,
    );
    const snapshotBlock =
      INDEXED_BLOCK -
      Math.floor((now - executedAt.getTime()) / 1000 / BLOCK_SECONDS);
    const id = `${cycleId}:${random.hex(8)}`;
    const rolledOver = i % 5 === 0;
    const pot = rolledOver
      ? wei(0.0002 + random.next() * 0.0002)
      : wei(0.01 + random.next() * 0.09);
    if (rolledOver) {
      draws.push({
        id,
        cycle_id: cycleId,
        scheduled_at: scheduledAt.toISOString(),
        executed_at: executedAt.toISOString(),
        snapshot_block: snapshotBlock,
        status: "rolled_over",
        pot_wei: pot.toString(),
        gas_reserve_wei: wei(0.02).toString(),
        eligible_count: eligible.length,
        eligible_balance: total.toString(),
        seed_hash: null,
        seed: null,
        revealed_at: null,
        skip_reason:
          "Pot is below the minimum; it rolls over into the next draw",
      });
      continue;
    }
    const seed = `0x${random.hex(32)}` as Hex;
    const winners = selectWinners(seed, eligible, config.winnersPerDraw);
    const amounts = splitPot(pot, winners.length);
    const settled = i > 1;
    draws.push({
      id,
      cycle_id: cycleId,
      scheduled_at: scheduledAt.toISOString(),
      executed_at: executedAt.toISOString(),
      snapshot_block: snapshotBlock,
      status: settled ? "paid" : "scheduled",
      pot_wei: pot.toString(),
      gas_reserve_wei: wei(0.02).toString(),
      eligible_count: eligible.length,
      eligible_balance: total.toString(),
      seed_hash: keccak256(seed),
      seed,
      revealed_at: settled ? executedAt.toISOString() : null,
      skip_reason: null,
    });
    winners.forEach((winner, index) => {
      const txHash = `0x${random.hex(32)}`;
      payouts.push({
        id: `${id}:${winner.address}`,
        draw_id: id,
        recipient: winner.address,
        amount_wei: amounts[index].toString(),
        balance_wei: winner.balance.toString(),
        odds_bps: Number((winner.balance * 10000n) / total),
        status: settled ? "confirmed" : "submitted",
        nonce: 400 + draws.length,
        tx_hash: txHash,
        raw_tx: `0x02${random.hex(90)}`,
        block_number: settled ? snapshotBlock + random.int(1, 6) : null,
        reason: null,
        created_at: executedAt.toISOString(),
        updated_at: executedAt.toISOString(),
        confirmed_at: settled
          ? new Date(executedAt.getTime() + 90 * 1000).toISOString()
          : null,
      });
    });
  }
  return { draws, payouts, eligible };
}

function buildTreasury(now: number) {
  const ops: Record<string, unknown>[] = [];
  const income: Record<string, unknown>[] = [];
  let nonce = 300;
  for (let i = 23; i >= 0; i--) {
    const createdAt = new Date(
      now - (35 + i * 82 + random.int(0, 20)) * 60 * 1000,
    );
    const kind = i % 2 === 0 ? "sweep" : "claim";
    const status = i === 0 ? "submitted" : i === 7 ? "failed" : "confirmed";
    const txHash = `0x${random.hex(32)}`;
    const block =
      INDEXED_BLOCK -
      Math.floor((now - createdAt.getTime()) / 1000 / BLOCK_SECONDS) +
      random.int(1, 6);
    const amount = wei(0.004 + random.next() * 0.03);
    ops.push({
      id: random.hex(16),
      kind,
      status,
      amount_in: amount.toString(),
      amount_out: status === "confirmed" ? amount.toString() : null,
      expected_out: amount.toString(),
      nonce: nonce++,
      raw_tx: `0x02${random.hex(90)}`,
      tx_hash: txHash,
      block_number: status === "submitted" ? null : block,
      reason:
        status === "failed"
          ? "Transaction reverted on chain"
          : kind === "sweep"
            ? "Creator share of curve fees to escrow"
            : "Escrow creator fees to vault",
      created_at: createdAt.toISOString(),
      updated_at: new Date(
        createdAt.getTime() + random.int(20, 400) * 1000,
      ).toISOString(),
    });
    if (status === "confirmed")
      income.push({
        id: `${txHash}:${kind === "sweep" ? 2 : 1}`,
        source: kind === "sweep" ? "sweep" : "escrow_claim",
        tx_hash: txHash,
        log_index: kind === "sweep" ? 2 : 1,
        amount_wei: amount.toString(),
        token_address: null,
        block_number: block,
        ts: createdAt.toISOString(),
      });
  }
  const points: Record<string, unknown>[] = [];
  const supply = 1e9;
  const ethUsd = 3080;
  const step = 60 * 1000;
  const count = Math.floor((24 * 3600 * 1000) / step) - 40;
  for (let i = count; i >= 0; i--) {
    const t = i / count;
    const drift =
      1 +
      0.42 * (1 - t) -
      0.18 * Math.sin(t * 9.3) * (1 - t) -
      0.06 * Math.cos(t * 23) ** 2;
    const priceUsd = 4.05e-9 * drift * (1 + 0.004 * random.normal()) * ethUsd;
    points.push({
      ts: new Date(now - i * step - random.int(0, 900)).toISOString(),
      price_usd: priceUsd,
      market_cap_usd: priceUsd * supply,
      source: "curve",
    });
  }
  const state = {
    status: "Waiting for 1 treasury transaction to confirm",
    isPons: true,
    phase: "curve",
    graduated: false,
    buybackEnabled: false,
    creatorTaxBps: 300,
    creatorFeeRecipientIsVault: true,
    curveAddress: CURVE,
    quoteSymbol: "ETH",
    quoteDecimals: 18,
    isNativeQuote: true,
    vaultEthWei: wei(0.2418).toString(),
    curveWei: wei(0.0164).toString(),
    escrowWei: wei(0.0031).toString(),
    incomeScanLag: 0,
    updatedAt: new Date(now).toISOString(),
  };
  return { ops, income, points, state, cursor: INDEXED_BLOCK - 12 };
}

async function insertRows(
  client: PoolClient,
  table: string,
  columns: string[],
  types: string[],
  rows: Record<string, unknown>[],
) {
  if (!rows.length) return;
  const definition = columns
    .map((column, i) => `${column} ${types[i]}`)
    .join(",");
  for (let offset = 0; offset < rows.length; offset += 250)
    await client.query(
      `INSERT INTO ${table}(${columns.join(",")}) SELECT ${columns.join(",")} FROM jsonb_to_recordset($1::jsonb) AS x(${definition})`,
      [JSON.stringify(rows.slice(offset, offset + 250))],
    );
}

async function seed(client: PoolClient) {
  const now = Date.now();
  const { holders, poolAddress } = buildHolders(now);
  const transfers = buildTransfers(now, holders, poolAddress);
  const { draws, payouts, eligible } = buildDraws(now, holders, poolAddress);
  const treasury = buildTreasury(now);
  const totalSupply = holders.reduce((sum, holder) => sum + holder.balance, 0n);
  await client.query("BEGIN");
  try {
    await client.query(
      "TRUNCATE hoodball.draw_payouts, hoodball.draws, hoodball.transfers, hoodball.tx_classifications, hoodball.holders, hoodball.pools, hoodball.config_audit, hoodball.treasury_ops, hoodball.treasury_income, hoodball.treasury_cursor, hoodball.treasury_state, hoodball.price_points RESTART IDENTITY",
    );
    await client.query(
      "UPDATE hoodball.runtime_config SET config=$1,updated_at=now() WHERE id=1",
      [JSON.stringify(config)],
    );
    await client.query(
      "UPDATE hoodball.indexer SET indexed_block=$1,indexed_hash=$2,head_block=$3,phase='live',error=NULL,last_synced_at=now(),halted=false,total_supply=$4 WHERE id=1",
      [
        INDEXED_BLOCK,
        `0x${sha256(`block:${INDEXED_BLOCK}`)}`,
        HEAD_BLOCK,
        totalSupply.toString(),
      ],
    );
    await insertRows(
      client,
      "hoodball.holders",
      ["address", "balance", "is_contract", "updated_block", "first_seen_at"],
      ["text", "numeric", "boolean", "bigint", "timestamptz"],
      holders.map((holder) => ({
        address: holder.address,
        balance: holder.balance.toString(),
        is_contract: holder.is_contract,
        updated_block: INDEXED_BLOCK,
        first_seen_at: holder.first_seen_at.toISOString(),
      })),
    );
    await insertRows(
      client,
      "hoodball.pools",
      ["address", "source", "pair_token", "fee"],
      ["text", "text", "text", "integer"],
      [
        {
          address: poolAddress,
          source: "swap-log",
          pair_token: null,
          fee: null,
        },
        { address: CURVE, source: "pons-curve", pair_token: null, fee: null },
      ],
    );
    await insertRows(
      client,
      "hoodball.transfers",
      [
        "tx_hash",
        "log_index",
        "block_number",
        "block_hash",
        "from_address",
        "to_address",
        "amount",
        "timestamp",
      ],
      [
        "text",
        "integer",
        "bigint",
        "text",
        "text",
        "text",
        "numeric",
        "timestamptz",
      ],
      transfers.map((transfer) => ({
        ...transfer,
        timestamp: transfer.timestamp.toISOString(),
        swap: undefined,
      })),
    );
    await insertRows(
      client,
      "hoodball.tx_classifications",
      ["tx_hash", "kind", "pool_address"],
      ["text", "text", "text"],
      transfers.map((transfer) => ({
        tx_hash: transfer.tx_hash,
        kind: transfer.swap ? "swap" : "transfer",
        pool_address: transfer.swap ? poolAddress : null,
      })),
    );
    await insertRows(
      client,
      "hoodball.draws",
      [
        "id",
        "cycle_id",
        "scheduled_at",
        "executed_at",
        "snapshot_block",
        "status",
        "pot_wei",
        "gas_reserve_wei",
        "eligible_count",
        "eligible_balance",
        "seed_hash",
        "seed",
        "revealed_at",
        "skip_reason",
      ],
      [
        "text",
        "bigint",
        "timestamptz",
        "timestamptz",
        "bigint",
        "text",
        "numeric",
        "numeric",
        "integer",
        "numeric",
        "text",
        "text",
        "timestamptz",
        "text",
      ],
      draws,
    );
    await insertRows(
      client,
      "hoodball.draw_payouts",
      [
        "id",
        "draw_id",
        "recipient",
        "amount_wei",
        "balance_wei",
        "odds_bps",
        "status",
        "nonce",
        "tx_hash",
        "raw_tx",
        "block_number",
        "reason",
        "created_at",
        "updated_at",
        "confirmed_at",
      ],
      [
        "text",
        "text",
        "text",
        "numeric",
        "numeric",
        "integer",
        "text",
        "bigint",
        "text",
        "text",
        "bigint",
        "text",
        "timestamptz",
        "timestamptz",
        "timestamptz",
      ],
      payouts,
    );
    await insertRows(
      client,
      "hoodball.treasury_ops",
      [
        "id",
        "kind",
        "status",
        "amount_in",
        "amount_out",
        "expected_out",
        "nonce",
        "raw_tx",
        "tx_hash",
        "block_number",
        "reason",
        "created_at",
        "updated_at",
      ],
      [
        "text",
        "text",
        "text",
        "numeric",
        "numeric",
        "numeric",
        "bigint",
        "text",
        "text",
        "bigint",
        "text",
        "timestamptz",
        "timestamptz",
      ],
      treasury.ops,
    );
    await insertRows(
      client,
      "hoodball.treasury_income",
      [
        "id",
        "source",
        "tx_hash",
        "log_index",
        "amount_wei",
        "token_address",
        "block_number",
        "ts",
      ],
      [
        "text",
        "text",
        "text",
        "integer",
        "numeric",
        "text",
        "bigint",
        "timestamptz",
      ],
      treasury.income,
    );
    await insertRows(
      client,
      "hoodball.price_points",
      ["ts", "price_usd", "market_cap_usd", "source"],
      ["timestamptz", "numeric", "numeric", "text"],
      treasury.points,
    );
    await client.query(
      "INSERT INTO hoodball.treasury_cursor(id,block) VALUES(1,$1)",
      [treasury.cursor],
    );
    await client.query(
      "INSERT INTO hoodball.treasury_state(id,state) VALUES(1,$1)",
      [JSON.stringify(treasury.state)],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
  console.log(
    `Seeded ${holders.length} holders (${CONTRACT_COUNT} contracts, 1 detected pool, ${eligible.length} eligible), ${transfers.length} transfers, ${draws.length} draws with ${payouts.length} payouts, ${treasury.ops.length} treasury ops and ${treasury.points.length} price points.`,
  );
  console.log(
    "Run the site read-only against this fixture: HOODBALL_WORKER_ENABLED=false npm run dev",
  );
}

async function main() {
  assertLocalTarget();
  await ensureSchema();
  const client = await pool().connect();
  try {
    await seed(client);
  } finally {
    client.release();
    await pool().end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Fixture seed failed");
  process.exitCode = 1;
});
