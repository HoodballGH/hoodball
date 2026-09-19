import { parseTransaction } from "viem";
import { randomBytes } from "node:crypto";
import type { PoolClient } from "pg";
import {
  decodeEventLog,
  decodeFunctionResult,
  encodeEventTopics,
  encodeFunctionData,
  erc20Abi,
  formatEther,
  keccak256,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { isUnderpricedRejection, suggestedGasPrice } from "./gas";
import { dueCycle } from "./draws";
import { CHAIN_ID, CONFIRMATIONS, EXPLORER_URL } from "./chain";
import { readConfig } from "./db";
import { assertChain, blockTag, rpc, rpcNumber } from "./rpc";
import {
  curveAbi,
  curveCall,
  describeLaunch,
  escrowAbi,
  multicall,
  multicall3Abi,
  MULTICALL3,
  PONS_FEE_ESCROW,
  sweepClaimable,
  WETH,
  wethAbi,
  type LaunchInfo,
} from "./pons";
import { ethUsd, readOnlyMode } from "./prices";
import type { RuntimeConfig, TreasuryData, TreasuryOp } from "./types";

export const limits = {
  gasReserve: () =>
    BigInt(process.env.HOODBALL_GAS_RESERVE_WEI ?? "20000000000000000"),
  minClaim: () =>
    BigInt(process.env.HOODBALL_MIN_CLAIM_WEI ?? "2000000000000000"),
  minSweep: () =>
    BigInt(process.env.HOODBALL_MIN_SWEEP_WEI ?? "2000000000000000"),
  intervalMs: () =>
    Math.max(
      0,
      Number(process.env.HOODBALL_TREASURY_INTERVAL_SECONDS ?? 30) || 0,
    ) * 1000,
  maxGasPrice: () =>
    BigInt(process.env.HOODBALL_MAX_GAS_PRICE_WEI ?? "100000000000"),
  ethFloor: () =>
    BigInt(process.env.HOODBALL_MIN_ETH_WEI ?? "1000000000000000"),
};
export const INCOME_WINDOW = Math.min(
  10000,
  Math.max(1000, Number(process.env.HOODBALL_INCOME_WINDOW ?? 10000) || 10000),
);
export const INCOME_WINDOWS_PER_CYCLE = 4;

export function moneyGate(
  env: Record<string, string | undefined> = process.env,
): { open: boolean; reason: string } {
  if (env.MONEY_ENABLED !== "true")
    return {
      open: false,
      reason:
        "Money execution is disabled in the deployment environment; treasury is read-only",
    };
  if (env.HOODBALL_TREASURY_ENABLED !== "true")
    return {
      open: false,
      reason:
        "Treasury automation is not enabled (HOODBALL_TREASURY_ENABLED); claimable fees are visible only",
    };
  return { open: true, reason: "" };
}

export type PlanInput = {
  graduated: boolean;
  buybackEnabled: boolean;
  recipientIsVault: boolean;
  pendingCurveWei: bigint;
  escrowWei: bigint;
  wethWei: bigint;
};
export type PlanLimits = { minSweep: bigint; minClaim: bigint };
export type PlanChoice =
  | { kind: "sweep" }
  | { kind: "claim" }
  | { kind: "unwrap" }
  | { kind: "none"; reason: string };

/**
 * At most one fee operation per cycle: sweep the curve, then claim the escrow,
 * then unwrap any WETH the escrow pushed to the vault so the pot is native ETH.
 */
export function choosePlan(input: PlanInput, l: PlanLimits): PlanChoice {
  let unsweepable = "";
  if (!input.graduated && input.pendingCurveWei >= l.minSweep) {
    if (input.buybackEnabled)
      unsweepable =
        "Pons operator sweeps curve fees for buyback-enabled launches";
    else if (!input.recipientIsVault)
      unsweepable =
        "Curve fees accrue to a creator fee recipient that is not the vault";
    else return { kind: "sweep" };
  }
  if (input.escrowWei >= l.minClaim) return { kind: "claim" };
  if (input.wethWei >= l.minClaim) return { kind: "unwrap" };
  return {
    kind: "none",
    reason:
      unsweepable || "Nothing to sweep or claim above the configured minimums",
  };
}

type OpRow = {
  id: string;
  kind: "sweep" | "claim" | "unwrap";
  status: string;
  amount_in: string | null;
  amount_out: string | null;
  expected_out: string | null;
  nonce: string | null;
  raw_tx: Hex | null;
  tx_hash: Hex | null;
  block_number: string | null;
  reason: string | null;
  created_at: Date;
  updated_at: Date;
};
type Receipt = {
  status: Hex;
  blockNumber: Hex;
  blockHash: Hex;
  logs: { address: string; data: Hex; topics: Hex[]; logIndex: Hex }[];
};
type Log = {
  address: string;
  data: Hex;
  topics: Hex[];
  blockNumber: Hex;
  transactionHash: Hex;
  logIndex: Hex;
};
export type TreasuryState = {
  status: string;
  isPons: boolean;
  phase: string;
  graduated: boolean;
  buybackEnabled: boolean;
  creatorTaxBps: number | null;
  creatorFeeRecipientIsVault: boolean | null;
  curveAddress: string | null;
  quoteSymbol: string;
  quoteDecimals: number;
  isNativeQuote: boolean;
  vaultEthWei: string | null;
  vaultWethWei: string | null;
  curveWei: string | null;
  escrowWei: string | null;
  incomeScanLag: number | null;
  updatedAt: string;
};
let lastRun = 0;
let status = "Treasury keeper is idle";
const topics = {
  claimed: encodeEventTopics({ abi: escrowAbi, eventName: "Claimed" })[0],
  transfer: encodeEventTopics({ abi: erc20Abi, eventName: "Transfer" })[0],
};
const pad = (address: string): Hex =>
  `0x${address.slice(2).toLowerCase().padStart(64, "0")}`;
const same = (a: string | null | undefined, b: string | null | undefined) =>
  !!a && !!b && a.toLowerCase() === b.toLowerCase();

async function saveState(
  client: PoolClient,
  state: Omit<TreasuryState, "updatedAt">,
) {
  await client.query(
    "INSERT INTO hoodball.treasury_state(id,state,updated_at) VALUES(1,$1,now()) ON CONFLICT(id) DO UPDATE SET state=EXCLUDED.state,updated_at=now()",
    [JSON.stringify({ ...state, updatedAt: new Date().toISOString() })],
  );
}
async function blockTimestamp(cache: Map<number, string>, height: number) {
  if (!cache.has(height)) {
    const block = await rpc<{ timestamp: Hex } | null>("eth_getBlockByNumber", [
      blockTag(height),
      false,
    ]);
    if (!block) throw new Error("Block unavailable for income timestamp");
    cache.set(
      height,
      new Date(rpcNumber(block.timestamp) * 1000).toISOString(),
    );
  }
  return cache.get(height)!;
}
async function recordIncome(
  client: PoolClient,
  row: {
    source: string;
    txHash: string;
    logIndex: number;
    amount: bigint;
    token: string | null;
    block: number;
    ts: string;
  },
) {
  await client.query(
    "INSERT INTO hoodball.treasury_income(id,source,tx_hash,log_index,amount_wei,token_address,block_number,ts) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(tx_hash,log_index) DO NOTHING",
    [
      `${row.txHash}:${row.logIndex}`,
      row.source,
      row.txHash,
      row.logIndex,
      row.amount.toString(),
      row.token,
      row.block,
      row.ts,
    ],
  );
}

async function reconcile(
  client: PoolClient,
  config: RuntimeConfig,
  launch: LaunchInfo,
  head: number,
) {
  const pending = await client.query<OpRow>(
    "SELECT * FROM hoodball.treasury_ops WHERE status IN ('signed','submitted') ORDER BY nonce",
  );
  const timestamps = new Map<number, string>();
  for (const op of pending.rows) {
    if (!op.tx_hash)
      throw new Error("Signed treasury op missing transaction hash");
    const receipt = await rpc<Receipt | null>("eth_getTransactionReceipt", [
      op.tx_hash,
    ]);
    if (!receipt || head - rpcNumber(receipt.blockNumber) < CONFIRMATIONS)
      continue;
    const block = await rpc<{ hash: string }>("eth_getBlockByNumber", [
      receipt.blockNumber,
      false,
    ]);
    if (!same(block.hash, receipt.blockHash))
      throw new Error("Treasury receipt is not canonical");
    const height = rpcNumber(receipt.blockNumber);
    let amountOut: bigint | null = null;
    let verified = false;
    if (/^0x0*1$/.test(receipt.status))
      for (const log of receipt.logs) {
        try {
          if (op.kind === "sweep" && same(log.address, launch.curve)) {
            const event = decodeEventLog({
              abi: curveAbi,
              data: log.data,
              topics: log.topics as [Hex, ...Hex[]],
              eventName: "FeesSwept",
            });
            amountOut = event.args.creatorAmount;
            verified = true;
            await recordIncome(client, {
              source: "sweep",
              txHash: op.tx_hash,
              logIndex: rpcNumber(log.logIndex),
              amount: amountOut,
              token: launch.isNativeQuote ? null : launch.pairToken,
              block: height,
              ts: await blockTimestamp(timestamps, height),
            });
          } else if (op.kind === "unwrap" && same(log.address, WETH)) {
            const event = decodeEventLog({
              abi: wethAbi,
              data: log.data,
              topics: log.topics as [Hex, ...Hex[]],
              eventName: "Withdrawal",
            });
            if (!same(event.args.src, config.vaultAddress)) continue;
            amountOut = event.args.wad;
            verified = true;
          } else if (
            op.kind === "claim" &&
            same(log.address, PONS_FEE_ESCROW)
          ) {
            const event = decodeEventLog({
              abi: escrowAbi,
              data: log.data,
              topics: log.topics as [Hex, ...Hex[]],
            });
            if (!same(event.args.recipient, config.vaultAddress)) continue;
            amountOut = event.args.amount;
            verified = true;
            await recordIncome(client, {
              source: "escrow_claim",
              txHash: op.tx_hash,
              logIndex: rpcNumber(log.logIndex),
              amount: amountOut,
              token:
                event.eventName === "ClaimedToken"
                  ? event.args.token.toLowerCase()
                  : null,
              block: height,
              ts: await blockTimestamp(timestamps, height),
            });
          }
        } catch {
          continue;
        }
      }
    const next = /^0x0+$/.test(receipt.status)
      ? "failed"
      : verified
        ? "confirmed"
        : "review";
    await client.query(
      "UPDATE hoodball.treasury_ops SET status=$2,block_number=$3,amount_out=COALESCE($4,amount_out),reason=COALESCE($5,reason),updated_at=now() WHERE id=$1",
      [
        op.id,
        next,
        height,
        amountOut?.toString() ?? null,
        next === "review"
          ? "Successful transaction did not emit the expected event"
          : next === "failed"
            ? "Transaction reverted on chain"
            : null,
      ],
    );
  }
}

async function scanIncome(
  client: PoolClient,
  config: RuntimeConfig,
  head: number,
): Promise<number> {
  const target = head - CONFIRMATIONS;
  const row = (
    await client.query("SELECT block FROM hoodball.treasury_cursor WHERE id=1")
  ).rows[0];
  let cursor = row
    ? Number(row.block)
    : Math.max(0, (config.startBlock ?? target) - 1);
  const timestamps = new Map<number, string>();
  for (
    let window = 0;
    window < INCOME_WINDOWS_PER_CYCLE && cursor < target;
    window++
  ) {
    const from = cursor + 1;
    const to = Math.min(target, from + INCOME_WINDOW - 1);
    const vault = pad(config.vaultAddress!);
    const [claims, pushes] = await Promise.all([
      rpc<Log[]>("eth_getLogs", [
        {
          address: PONS_FEE_ESCROW,
          fromBlock: blockTag(from),
          toBlock: blockTag(to),
          topics: [topics.claimed, vault],
        },
      ]),
      rpc<Log[]>("eth_getLogs", [
        {
          address: WETH,
          fromBlock: blockTag(from),
          toBlock: blockTag(to),
          topics: [topics.transfer, pad(PONS_FEE_ESCROW), vault],
        },
      ]),
    ]);
    if (!Array.isArray(claims) || !Array.isArray(pushes))
      throw new Error("Malformed income logs");
    for (const log of claims) {
      const event = decodeEventLog({
        abi: escrowAbi,
        data: log.data,
        topics: log.topics as [Hex, ...Hex[]],
        eventName: "Claimed",
      });
      const height = rpcNumber(log.blockNumber);
      await recordIncome(client, {
        source: "escrow_claim",
        txHash: log.transactionHash,
        logIndex: rpcNumber(log.logIndex),
        amount: event.args.amount,
        token: null,
        block: height,
        ts: await blockTimestamp(timestamps, height),
      });
    }
    for (const log of pushes) {
      const event = decodeEventLog({
        abi: erc20Abi,
        data: log.data,
        topics: log.topics as [Hex, ...Hex[]],
        eventName: "Transfer",
      });
      const height = rpcNumber(log.blockNumber);
      await recordIncome(client, {
        source: "escrow_push",
        txHash: log.transactionHash,
        logIndex: rpcNumber(log.logIndex),
        amount: event.args.value,
        token: WETH.toLowerCase(),
        block: height,
        ts: await blockTimestamp(timestamps, height),
      });
    }
    await client.query(
      "INSERT INTO hoodball.treasury_cursor(id,block,updated_at) VALUES(1,$1,now()) ON CONFLICT(id) DO UPDATE SET block=GREATEST(hoodball.treasury_cursor.block,EXCLUDED.block),updated_at=now()",
      [to],
    );
    cursor = to;
  }
  return Math.max(0, target - cursor);
}

type ChainState = {
  vaultEthWei: bigint;
  vaultWethWei: bigint;
  pendingCurveWei: bigint;
  escrowWei: bigint;
  buybackQuoteWei: bigint;
  buybackEnabled: boolean;
};
async function readState(
  config: RuntimeConfig,
  launch: LaunchInfo,
): Promise<ChainState> {
  const vault = config.vaultAddress! as Hex;
  const calls = [
    {
      target: MULTICALL3,
      data: encodeFunctionData({
        abi: multicall3Abi,
        functionName: "getEthBalance",
        args: [vault],
      }),
    },
    {
      target: PONS_FEE_ESCROW,
      data: launch.isNativeQuote
        ? encodeFunctionData({
            abi: escrowAbi,
            functionName: "balanceOf",
            args: [vault],
          })
        : encodeFunctionData({
            abi: escrowAbi,
            functionName: "balanceOfToken",
            args: [vault, launch.pairToken as Hex],
          }),
    },

    {
      target: WETH,
      data: encodeFunctionData({
        abi: wethAbi,
        functionName: "balanceOf",
        args: [vault],
      }),
    },
  ];
  const curveCalls =
    launch.curve && !launch.graduated
      ? [
          curveCall(launch.curve, "quoteFeeBalance"),
          curveCall(launch.curve, "creatorTaxBalance"),
          curveCall(launch.curve, "protocolFeeShareBps"),
          curveCall(launch.curve, "buybackEnabled"),
          curveCall(launch.curve, "buybackQuoteBalance"),
          curveCall(launch.curve, "graduated"),
        ]
      : [];
  const results = await multicall([...calls, ...curveCalls]);
  const uint = (index: number) => {
    if (!results[index].success) throw new Error("Treasury state read failed");
    return BigInt(results[index].data);
  };
  const state: ChainState = {
    vaultEthWei: uint(0),
    escrowWei: uint(1),
    vaultWethWei: uint(2),
    pendingCurveWei: 0n,
    buybackQuoteWei: 0n,
    buybackEnabled: launch.buybackEnabled,
  };
  if (curveCalls.length) {
    const base = calls.length;
    const graduated = uint(base + 5) !== 0n;
    state.buybackEnabled = uint(base + 3) !== 0n;
    state.buybackQuoteWei = uint(base + 4);
    state.pendingCurveWei = graduated
      ? 0n
      : sweepClaimable(uint(base), uint(base + 1), uint(base + 2));
  }
  return state;
}

type OpReprice = {
  account: ReturnType<typeof privateKeyToAccount>;
  nonce: bigint;
};

async function repriceOp(
  client: PoolClient,
  op: { id: string; raw_tx: Hex; tx_hash: Hex },
  r: OpReprice,
) {
  const latest = BigInt(
    await rpc<Hex>("eth_getTransactionCount", [r.account.address, "latest"]),
  );
  if (latest !== r.nonce) return null;
  const gasPrice = await suggestedGasPrice(limits.maxGasPrice());
  if (gasPrice > limits.maxGasPrice()) return null;
  const parsed = parseTransaction(op.raw_tx);
  if (parsed.to === undefined || parsed.gas === undefined) return null;
  const raw = await r.account.signTransaction({
    chainId: CHAIN_ID,
    to: parsed.to,
    data: parsed.data,
    value: parsed.value ?? 0n,
    gas: parsed.gas,
    gasPrice,
    nonce: Number(r.nonce),
    type: "legacy",
  });
  const hash = keccak256(raw);
  const stored = await client.query(
    "UPDATE hoodball.treasury_ops SET raw_tx=$2,tx_hash=$3,updated_at=now() WHERE id=$1 AND status='signed' AND tx_hash=$4",
    [op.id, raw, hash, op.tx_hash],
  );
  if (!stored.rowCount) return null;
  return { raw_tx: raw, tx_hash: hash };
}

async function broadcast(
  client: PoolClient,
  op: { id: string; raw_tx: Hex; tx_hash: Hex },
  r?: OpReprice,
): Promise<boolean> {
  let rejection: unknown;
  try {
    const hash = await rpc<Hex>("eth_sendRawTransaction", [op.raw_tx]);
    if (!same(hash, op.tx_hash)) throw new Error("Broadcast hash mismatch");
    await client.query(
      "UPDATE hoodball.treasury_ops SET status='submitted',updated_at=now() WHERE id=$1",
      [op.id],
    );
    return true;
  } catch (error) {
    rejection = error;
  }
  const known = await rpc<{ hash: Hex } | null>("eth_getTransactionByHash", [
    op.tx_hash,
  ]);
  if (known) {
    await client.query(
      "UPDATE hoodball.treasury_ops SET status='submitted',updated_at=now() WHERE id=$1",
      [op.id],
    );
    return true;
  }
  if (r && isUnderpricedRejection(rejection)) {
    const next = await repriceOp(client, op, r);
    if (next) return broadcast(client, { id: op.id, ...next });
  }
  console.error(
    `Treasury op ${op.id} broadcast rejected: ${rejection instanceof Error ? rejection.message : "unknown"}`,
  );
  status =
    "A signed treasury transaction is awaiting network acceptance; its exact bytes are retained";
  return false;
}

type Intent = {
  kind: "sweep" | "claim" | "unwrap";
  to: string;
  data: Hex;
  amountIn: bigint;
  expectedOut: bigint;
  reason: string;
  gasCap: bigint;
  verify?: (result: Hex) => void;
};
async function execute(
  client: PoolClient,
  account: ReturnType<typeof privateKeyToAccount>,
  intent: Intent,
  nonce: bigint,
  gasPrice: bigint,
  ethBalance: bigint,
) {
  const request = { from: account.address, to: intent.to, data: intent.data };
  const result = await rpc<Hex>("eth_call", [request, "pending"]);
  intent.verify?.(result);
  const gas =
    (BigInt(await rpc<Hex>("eth_estimateGas", [request])) * 120n) / 100n;
  if (gas > intent.gasCap)
    throw new Error(`${intent.kind} gas estimate exceeds limit`);
  if (ethBalance - gas * gasPrice < limits.ethFloor()) {
    status = "Vault needs ETH for treasury transaction fees";
    return false;
  }
  if (nonce > BigInt(Number.MAX_SAFE_INTEGER))
    throw new Error("Unsupported vault nonce");
  const raw = await account.signTransaction({
    chainId: CHAIN_ID,
    to: intent.to as Hex,
    data: intent.data,
    gas,
    gasPrice,
    nonce: Number(nonce),
    type: "legacy",
  });
  const hash = keccak256(raw);
  const id = randomBytes(16).toString("hex");
  await client.query(
    "INSERT INTO hoodball.treasury_ops(id,kind,status,amount_in,expected_out,nonce,raw_tx,tx_hash,reason) VALUES($1,$2,'signed',$3,$4,$5,$6,$7,$8)",
    [
      id,
      intent.kind,
      intent.amountIn.toString(),
      intent.expectedOut.toString(),
      nonce.toString(),
      raw,
      hash,
      intent.reason,
    ],
  );
  await broadcast(client, { id, raw_tx: raw, tx_hash: hash }, { account, nonce });
  status = `${intent.kind === "sweep" ? "Curve fee sweep" : intent.kind === "claim" ? "Escrow fee claim" : "WETH unwrap"} is being confirmed on chain`;
  return true;
}

export async function runTreasury(client: PoolClient) {
  if (readOnlyMode()) return;
  const config = await readConfig(client);
  if (!config.tokenAddress || !config.vaultAddress) return;
  if (Date.now() - lastRun < limits.intervalMs()) return;
  lastRun = Date.now();
  const launch = await describeLaunch(config.tokenAddress);
  const base = {
    isPons: launch.launched,
    phase: launch.phaseName,
    graduated: launch.graduated,
    buybackEnabled: launch.buybackEnabled,
    creatorTaxBps: launch.creatorTaxBps,
    creatorFeeRecipientIsVault: launch.launched
      ? same(launch.creatorFeeRecipient, config.vaultAddress)
      : null,
    curveAddress: launch.curve,
    quoteSymbol:
      launch.quote?.symbol ?? (launch.isNativeQuote ? "ETH" : launch.pairToken),
    quoteDecimals: launch.quote?.decimals ?? 18,
    isNativeQuote: launch.isNativeQuote,
  };
  if (!launch.launched) {
    await saveState(client, {
      ...base,
      status: "Token is not a Pons launch; fee automation is inactive",
      vaultEthWei: null,
      vaultWethWei: null,
      curveWei: null,
      escrowWei: null,
      incomeScanLag: null,
    });
    return;
  }
  await assertChain();
  const head = rpcNumber(await rpc<Hex>("eth_blockNumber"));
  await reconcile(client, config, launch, head);
  const lag = await scanIncome(client, config, head);
  const state = await readState(config, launch);
  const persist = () =>
    saveState(client, {
      ...base,
      buybackEnabled: state.buybackEnabled,
      status,
      vaultEthWei: state.vaultEthWei.toString(),
      vaultWethWei: state.vaultWethWei.toString(),
      curveWei: state.pendingCurveWei.toString(),
      escrowWei: state.escrowWei.toString(),
      incomeScanLag: lag,
    });
  const gate = moneyGate();
  if (!gate.open) {
    status = gate.reason;
    await persist();
    return;
  }
  const key = process.env.HOODBALL_VAULT_PRIVATE_KEY;
  if (!key || !/^0x[\da-f]{64}$/i.test(key)) {
    status = "Vault signing key has not been configured";
    await persist();
    return;
  }
  const account = privateKeyToAccount(key as Hex);
  if (!same(account.address, config.vaultAddress))
    throw new Error("Vault signer does not match configured vault");
  const lock = await client.query(
    "SELECT pg_try_advisory_lock(hashtextextended($1,4663)) AS acquired",
    [account.address.toLowerCase()],
  );
  if (!lock.rows[0].acquired) {
    status = "Waiting for the draw signer to release the vault";
    await persist();
    return;
  }
  try {
    if (
      (
        await client.query(
          "SELECT 1 FROM hoodball.treasury_ops WHERE status='review' LIMIT 1",
        )
      ).rowCount
    ) {
      status =
        "A treasury transaction needs operator review; automation is paused";
      return;
    }
    const pending = await client.query<OpRow>(
      "SELECT * FROM hoodball.treasury_ops WHERE status IN ('signed','submitted') ORDER BY nonce",
    );
    if (pending.rowCount) {
      const latestNonce = BigInt(
        await rpc<Hex>("eth_getTransactionCount", [account.address, "latest"]),
      );
      for (const op of pending.rows) {
        if (
          await rpc<Receipt | null>("eth_getTransactionReceipt", [op.tx_hash])
        )
          continue;
        const known = await rpc<{ hash: Hex } | null>(
          "eth_getTransactionByHash",
          [op.tx_hash],
        );
        if (op.nonce !== null && latestNonce > BigInt(op.nonce)) {
          if (!known) {
            await client.query(
              "UPDATE hoodball.treasury_ops SET status='failed',reason='Dropped: vault nonce was consumed externally before broadcast; the keeper will plan it again',updated_at=now() WHERE id=$1",
              [op.id],
            );
            continue;
          }
          await client.query(
            "UPDATE hoodball.treasury_ops SET status='review',reason='Vault nonce consumed by another transaction',updated_at=now() WHERE id=$1",
            [op.id],
          );
          status = "A vault nonce conflict needs operator review";
          return;
        }
        if (
          !known &&
          !(await broadcast(
            client,
            { id: op.id, raw_tx: op.raw_tx!, tx_hash: op.tx_hash! },
            { account, nonce: BigInt(op.nonce!) },
          ))
        )
          return;
        if (known && op.status === "signed")
          await client.query(
            "UPDATE hoodball.treasury_ops SET status='submitted',updated_at=now() WHERE id=$1",
            [op.id],
          );
      }
      status = `Waiting for ${pending.rowCount} treasury transaction${pending.rowCount === 1 ? "" : "s"} to confirm`;
      return;
    }
    if (
      (
        await client.query(
          "SELECT 1 FROM hoodball.draw_payouts WHERE status IN ('signed','submitted') LIMIT 1",
        )
      ).rowCount
    ) {
      status = "Waiting for draw payouts to confirm before treasury work";
      return;
    }
    const recentFailures = Number(
      (
        await client.query(
          "SELECT count(*)::text AS count FROM hoodball.treasury_ops WHERE status='failed' AND updated_at > now() - interval '1 hour'",
        )
      ).rows[0].count,
    );
    if (recentFailures >= 3) {
      status = `Treasury paused: ${recentFailures} transactions failed on chain in the last hour; operator review needed`;
      return;
    }
    const choice = choosePlan(
      {
        graduated: launch.graduated,
        buybackEnabled: state.buybackEnabled || state.buybackQuoteWei > 0n,
        recipientIsVault: same(launch.creatorFeeRecipient, config.vaultAddress),
        pendingCurveWei: state.pendingCurveWei,
        escrowWei: state.escrowWei,
        wethWei: state.vaultWethWei,
      },
      { minSweep: limits.minSweep(), minClaim: limits.minClaim() },
    );
    if (choice.kind === "none") {
      status = choice.reason;
      return;
    }
    // Draws have priority over fee claims: never start a new treasury
    // transaction while a draw is due (or within 60 s of one) or a payout is
    // queued, otherwise continuous claiming starves the draw indefinitely.
    const lastDraw = (
      await client.query(
        "SELECT cycle_id FROM hoodball.draws ORDER BY cycle_id DESC LIMIT 1",
      )
    ).rows[0];
    const soonMs = Date.now() + 60_000;
    const drawDue =
      dueCycle(soonMs, config.drawIntervalSeconds, lastDraw ? Number(lastDraw.cycle_id) : null) !== null;
    const payoutsQueued = !!(
      await client.query(
        "SELECT 1 FROM hoodball.draw_payouts WHERE status IN ('queued','signed','submitted') LIMIT 1",
      )
    ).rowCount;
    if (drawDue || payoutsQueued) {
      status = "Holding fee claims until the draw pays out";
      return;
    }
    const latestNonce = BigInt(
      await rpc<Hex>("eth_getTransactionCount", [account.address, "latest"]),
    );
    const nonce = BigInt(
      await rpc<Hex>("eth_getTransactionCount", [account.address, "pending"]),
    );
    if (latestNonce !== nonce) {
      status = "Waiting for other vault transactions to confirm";
      return;
    }
    const gasPrice = await suggestedGasPrice(limits.maxGasPrice());
    if (gasPrice > limits.maxGasPrice()) {
      status = "Network fee exceeds the configured limit";
      return;
    }
    const intent: Intent =
      choice.kind === "sweep"
        ? {
            kind: "sweep",
            to: launch.curve!,
            data: encodeFunctionData({
              abi: curveAbi,
              functionName: "sweepFees",
              args: [0n],
            }),
            amountIn: state.pendingCurveWei,
            expectedOut: state.pendingCurveWei,
            reason: "Creator share of curve fees to escrow",
            gasCap: 400000n,
          }
        : choice.kind === "unwrap"
          ? {
              kind: "unwrap",
              to: WETH,
              data: encodeFunctionData({
                abi: wethAbi,
                functionName: "withdraw",
                args: [state.vaultWethWei],
              }),
              amountIn: state.vaultWethWei,
              expectedOut: state.vaultWethWei,
              reason: "Unwrap escrow-pushed WETH into the ETH pot",
              gasCap: 120000n,
            }
          : {
            kind: "claim",
            to: PONS_FEE_ESCROW,
            data: launch.isNativeQuote
              ? encodeFunctionData({ abi: escrowAbi, functionName: "claim" })
              : encodeFunctionData({
                  abi: escrowAbi,
                  functionName: "claimToken",
                  args: [launch.pairToken as Hex],
                }),
            amountIn: state.escrowWei,
            expectedOut: state.escrowWei,
            reason: "Escrow creator fees to vault",
            gasCap: 300000n,
            verify: (result) => {
              if (
                decodeFunctionResult({
                  abi: escrowAbi,
                  functionName: "claim",
                  data: result,
                }) !== state.escrowWei
              )
                throw new Error(
                  "Escrow claim simulation did not return the vault balance",
                );
            },
          };
    try {
      await execute(
        client,
        account,
        intent,
        nonce,
        gasPrice,
        state.vaultEthWei,
      );
    } catch (error) {
      status = `Treasury ${intent.kind} could not be prepared: ${error instanceof Error ? error.message : "unknown error"}`;
      throw error;
    }
  } finally {
    await client.query("SELECT pg_advisory_unlock(hashtextextended($1,4663))", [
      account.address.toLowerCase(),
    ]);
    await persist();
  }
}
export function resetTreasuryThrottle() {
  lastRun = 0;
}

const fmtEth = (wei: string | bigint | null) =>
  wei === null ? null : formatEther(BigInt(wei));

export async function readTreasuryState(
  client: PoolClient,
): Promise<TreasuryState | null> {
  const row = (
    await client.query("SELECT state FROM hoodball.treasury_state WHERE id=1")
  ).rows[0];
  return (row?.state ?? null) as TreasuryState | null;
}

export async function getTreasurySnapshot(
  client: PoolClient,
  config: RuntimeConfig,
): Promise<{
  treasury: TreasuryData;
  state: TreasuryState | null;
  version: unknown;
}> {
  const state = await readTreasuryState(client);
  const recentRows = (
    await client.query<OpRow>(
      "SELECT * FROM hoodball.treasury_ops ORDER BY created_at DESC,id DESC LIMIT 20",
    )
  ).rows;
  const groups = (
    await client.query(
      "SELECT kind,status,count(*)::int AS n,COALESCE(sum(amount_in),0)::text AS amount_in,COALESCE(sum(amount_out),0)::text AS amount_out FROM hoodball.treasury_ops GROUP BY kind,status",
    )
  ).rows;
  const income = (
    await client.query(
      "SELECT source,COALESCE(sum(amount_wei),0)::text AS total FROM hoodball.treasury_income GROUP BY source",
    )
  ).rows;
  const totals = {
    claimedEth: 0n,
    sweptEth: 0n,
    incomeEth: 0n,
    claims: 0,
    sweeps: 0,
  };
  let pendingOps = 0;
  for (const group of groups) {
    if (["queued", "signed", "submitted"].includes(group.status))
      pendingOps += group.n;
    if (group.status !== "confirmed") continue;
    if (group.kind === "claim") {
      totals.claimedEth += BigInt(group.amount_out);
      totals.claims += group.n;
    }
    if (group.kind === "sweep") {
      totals.sweptEth += BigInt(group.amount_out);
      totals.sweeps += group.n;
    }
  }
  for (const row of income)
    if (row.source !== "sweep") totals.incomeEth += BigInt(row.total);
  const recent = recentRows.map(formatOp);
  const gate = moneyGate();
  const eth = readOnlyMode() ? null : await ethUsd();
  const vaultEth = state?.vaultEthWei
    ? formatEther(BigInt(state.vaultEthWei))
    : null;
  const curve = state?.curveWei ?? null;
  const escrow = state?.escrowWei ?? null;
  const total =
    curve !== null && escrow !== null
      ? (BigInt(curve) + BigInt(escrow)).toString()
      : null;
  const treasury: TreasuryData = {
    enabled: gate.open,
    status:
      !config.tokenAddress || !config.vaultAddress
        ? "Treasury awaits the token and vault configuration"
        : readOnlyMode()
          ? "Treasury reads are disabled on this read-only instance"
          : (state?.status ??
            (gate.open ? "Treasury keeper is starting" : gate.reason)),
    vaultEth,
    vaultEthUsd:
      vaultEth !== null && eth !== null ? Number(vaultEth) * eth : null,
    gasReserveEth: formatEther(limits.gasReserve()),
    claimable: {
      curveEth: fmtEth(curve),
      escrowEth: fmtEth(escrow),
      totalEth: fmtEth(total),
    },
    totals: {
      claimedEth: formatEther(totals.claimedEth),
      sweptEth: formatEther(totals.sweptEth),
      incomeEth: formatEther(totals.incomeEth),
      claims: totals.claims,
      sweeps: totals.sweeps,
    },
    launch: {
      isPons: state?.isPons ?? false,
      phase: state?.phase ?? (config.tokenAddress ? "unknown" : "prelaunch"),
      graduated: state?.graduated ?? false,
      buybackEnabled: state?.buybackEnabled ?? false,
      creatorTaxBps: state?.creatorTaxBps ?? null,
      creatorFeeRecipientIsVault: state?.creatorFeeRecipientIsVault ?? null,
      curveAddress: state?.curveAddress ?? null,
      escrowAddress: PONS_FEE_ESCROW.toLowerCase(),
      quoteSymbol: state?.quoteSymbol ?? null,
      isNativeQuote: state?.isNativeQuote ?? null,
      pendingOps,
    },
    recent,
    updatedAt: state?.updatedAt ?? new Date().toISOString(),
  };
  const round6 = (value: string | null) =>
    value === null ? null : Number(value).toFixed(6);
  return {
    treasury,
    state,
    version: {
      totals: treasury.totals,
      recent: recent.map((op) => [op.id, op.status]),
      claimable: [
        round6(treasury.claimable.curveEth),
        round6(treasury.claimable.escrowEth),
      ],
      status: treasury.status,
      vaultEth: round6(vaultEth),
    },
  };
}

export function formatOp(row: OpRow): TreasuryOp {
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    amountIn:
      row.amount_in === null ? null : formatEther(BigInt(row.amount_in)),
    amountOut:
      row.amount_out === null ? null : formatEther(BigInt(row.amount_out)),
    txHash: row.tx_hash,
    explorerUrl: row.tx_hash ? `${EXPLORER_URL}/tx/${row.tx_hash}` : null,
    createdAt: new Date(row.created_at).toISOString(),
    reason: row.reason,
  };
}

export async function listTreasuryOps(
  client: PoolClient,
  offset: number,
  limit: number,
) {
  const rows = (
    await client.query<OpRow>(
      "SELECT * FROM hoodball.treasury_ops ORDER BY created_at DESC,id DESC LIMIT $1 OFFSET $2",
      [limit, offset],
    )
  ).rows;
  const total = Number(
    (
      await client.query(
        "SELECT count(*)::text AS count FROM hoodball.treasury_ops",
      )
    ).rows[0].count,
  );
  const income = (
    await client.query(
      "SELECT source,count(*)::int AS n,COALESCE(sum(amount_wei),0)::text AS total FROM hoodball.treasury_income GROUP BY source ORDER BY source",
    )
  ).rows;
  return {
    total,
    offset,
    limit,
    ops: rows.map((row) => ({
      ...formatOp(row),
      blockNumber: row.block_number === null ? null : Number(row.block_number),
      nonce: row.nonce === null ? null : Number(row.nonce),
      expectedOut:
        row.expected_out === null
          ? null
          : formatEther(BigInt(row.expected_out)),
    })),
    income: income.map((row) => ({
      source: row.source,
      count: row.n,
      totalEth: formatEther(BigInt(row.total)),
    })),
  };
}

export function emptyTreasury(): TreasuryData {
  const gate = moneyGate();
  return {
    enabled: gate.open,
    status: "Treasury awaits the token and vault configuration",
    vaultEth: null,
    vaultEthUsd: null,
    gasReserveEth: formatEther(limits.gasReserve()),
    claimable: { curveEth: null, escrowEth: null, totalEth: null },
    totals: {
      claimedEth: "0",
      sweptEth: "0",
      incomeEth: "0",
      claims: 0,
      sweeps: 0,
    },
    launch: {
      isPons: false,
      phase: "prelaunch",
      graduated: false,
      buybackEnabled: false,
      creatorTaxBps: null,
      creatorFeeRecipientIsVault: null,
      curveAddress: null,
      escrowAddress: PONS_FEE_ESCROW.toLowerCase(),
      quoteSymbol: null,
      isNativeQuote: null,
      pendingOps: 0,
    },
    recent: [],
    updatedAt: new Date().toISOString(),
  };
}
