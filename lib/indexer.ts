import {
  decodeEventLog,
  encodeFunctionData,
  decodeFunctionResult,
  erc20Abi,
  parseAbiItem,
} from "viem";
import type { PoolClient } from "pg";
import { CHAIN_ID, CONFIRMATIONS, ZERO_ADDRESS } from "./chain";
import { pool, ensureSchema, readConfig } from "./db";
import type { RuntimeConfig } from "./types";
import { rpc, rpcBatch, rpcNumber, blockTag } from "./rpc";
import { multicall } from "./pons";
import { applyTransfer, type BalanceState } from "./indexer-state";
import { ensureVaultFromKey, runDraws } from "./draws";
import { refreshPools } from "./pools";
import { runTreasury } from "./treasury";
import { refreshSwapClassifications } from "./swaps";
import { refreshSnapshot } from "./snapshot";
const event = parseAbiItem(
  "event Transfer(address indexed from, address indexed to, uint256 value)",
);
const topic =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
type Block = { number: string; hash: string; timestamp: string };
type Log = {
  address: string;
  blockNumber: string;
  blockHash: string;
  transactionHash: string;
  transactionIndex: string;
  logIndex: string;
  data: `0x${string}`;
  topics: [`0x${string}`, ...`0x${string}`[]];
  removed?: boolean;
};
class HistoryError extends Error {}
const envInt = (name: string, fallback: number, min: number) =>
  Math.max(min, Math.floor(Number(process.env[name] ?? fallback) || fallback));
const STATE_WINDOW = envInt("HOODBALL_RPC_STATE_WINDOW", 3000, 64);
const MAX_LOG_WINDOW = Math.min(10000, envInt("HOODBALL_INDEX_WINDOW", 10000, 1000));
const MIN_LOG_WINDOW = 1000;
const LOG_LIMIT = 10000;
const TICK_BUDGET_MS = envInt("HOODBALL_INDEX_TICK_BUDGET_MS", 40000, 1000);
let logWindow = MAX_LOG_WINDOW;
let running = false;
let caughtUp = false;
let timer: ReturnType<typeof setTimeout> | undefined;
function checkBlock(block: Block | null | undefined, height: number): Block {
  if (!block?.hash || rpcNumber(block.number) !== height)
    throw new Error("RPC block is unavailable");
  return block;
}
async function blockAt(height: number) {
  return checkBlock(
    await rpc<Block | null>("eth_getBlockByNumber", [blockTag(height), false]),
    height,
  );
}
async function blocksAt(heights: number[]) {
  const blocks = await rpcBatch<Block | null>(
    heights.map((height) => ({
      method: "eth_getBlockByNumber",
      params: [blockTag(height), false],
    })),
  );
  return new Map(heights.map((height, i) => [height, checkBlock(blocks[i], height)]));
}
const isStateUnavailable = (error: unknown) =>
  error instanceof Error && /-32000|-32001|missing trie|not found|metadata/i.test(error.message);
async function fetchLogs(tokenAddress: string, from: number, target: number) {
  let to = Math.min(target, from + logWindow - 1);
  let attempts = 0;
  while (true) {
    try {
      const logs = await rpc<Log[]>("eth_getLogs", [
        {
          address: tokenAddress,
          fromBlock: blockTag(from),
          toBlock: blockTag(to),
          topics: [topic],
        },
      ]);
      if (!Array.isArray(logs)) throw new Error("Malformed RPC logs");
      if (logs.length >= LOG_LIMIT && to > from) {
        to = from + Math.floor((to - from) / 2);
        continue;
      }
      if (logs.length >= LOG_LIMIT)
        throw new HistoryError(
          "RPC log result reaches provider limit in one block; full history cannot be verified",
        );
      const span = to - from + 1;
      if (logs.length < LOG_LIMIT / 4 && span >= logWindow)
        logWindow = Math.min(MAX_LOG_WINDOW, logWindow * 2);
      return { logs, to };
    } catch (error) {
      if (error instanceof HistoryError || to === from || attempts++ >= 12) throw error;
      to = from + Math.floor((to - from) / 2);
      logWindow = Math.max(MIN_LOG_WINDOW, Math.min(logWindow, to - from + 1));
    }
  }
}
const balanceCall = (token: string, address: string) => ({
  target: token,
  allowFailure: false,
  data: encodeFunctionData({
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [address as `0x${string}`],
  }),
});
async function chainBalances(token: string, addresses: string[], tag: string) {
  const out = new Map<string, bigint>();
  for (let offset = 0; offset < addresses.length; offset += 300) {
    const slice = addresses.slice(offset, offset + 300);
    const results = await multicall(
      slice.map((address) => balanceCall(token, address)),
      tag,
    );
    results.forEach((result, i) => {
      if (!result.success) throw new Error("balanceOf call reverted");
      out.set(
        slice[i],
        decodeFunctionResult({ abi: erc20Abi, functionName: "balanceOf", data: result.data }),
      );
    });
  }
  return out;
}
async function chainSupply(token: string, tag: string) {
  const data = await rpc<`0x${string}`>("eth_call", [
    { to: token, data: encodeFunctionData({ abi: erc20Abi, functionName: "totalSupply" }) },
    tag,
  ]);
  return decodeFunctionResult({ abi: erc20Abi, functionName: "totalSupply", data });
}
async function verifyAgainstChain(
  client: PoolClient,
  config: RuntimeConfig & { tokenAddress: string },
  block: number,
  balances: Map<string, BalanceState>,
  full: boolean,
) {
  const tag = blockTag(block);
  const targets = new Map<string, bigint>();
  for (const [address, state] of balances) targets.set(address, state.balance);
  if (full) {
    const rows = await client.query(
      "SELECT address,balance FROM hoodball.holders WHERE balance > 0",
    );
    for (const row of rows.rows)
      if (!targets.has(row.address)) targets.set(row.address, BigInt(row.balance));
  }
  const addresses = [...targets.keys()];
  const [onChain, supply] = await Promise.all([
    chainBalances(config.tokenAddress, addresses, tag),
    chainSupply(config.tokenAddress, tag),
  ]);
  for (const address of addresses)
    if (onChain.get(address) !== targets.get(address))
      throw new HistoryError(
        "Indexed holder balance differs from chain state; unsupported token mechanics or incomplete logs",
      );
  return supply;
}
async function indexChunk(client: PoolClient): Promise<boolean> {
  const config = await readConfig(client);
  if (!config.tokenAddress || config.startBlock === null) {
    try {
      const [chainId, headHex] = await rpcBatch<string>([
        { method: "eth_chainId", params: [] },
        { method: "eth_blockNumber", params: [] },
      ]);
      if (BigInt(chainId) !== BigInt(CHAIN_ID))
        throw new Error("RPC chain mismatch; expected Robinhood Chain 4663");
      await client.query(
        "UPDATE hoodball.indexer SET head_block=$1,phase='prelaunch',error=NULL,total_supply=NULL,last_synced_at=now() WHERE id=1",
        [rpcNumber(headHex)],
      );
    } catch (error) {
      console.error(
        "Hoodball worker (prelaunch):",
        error instanceof Error ? error.message : "Unknown RPC error",
      );
      await client.query(
        "UPDATE hoodball.indexer SET phase='prelaunch',error=$1 WHERE id=1",
        [
          "Robinhood Chain RPC is temporarily unreachable. No token is configured; no holder data is affected.",
        ],
      );
    }
    return true;
  }
  const token = config.tokenAddress.toLowerCase();
  const state = (
    await client.query("SELECT * FROM hoodball.indexer WHERE id=1")
  ).rows[0];
  const indexed = state.indexed_block === null ? null : Number(state.indexed_block);
  const [chainId, headHex, indexedBlock] = await rpcBatch<string | Block | null>([
    { method: "eth_chainId", params: [] },
    { method: "eth_blockNumber", params: [] },
    ...(indexed === null
      ? []
      : [{ method: "eth_getBlockByNumber", params: [blockTag(indexed), false] }]),
  ]);
  if (BigInt(chainId as string) !== BigInt(CHAIN_ID))
    throw new Error("RPC chain mismatch; expected Robinhood Chain 4663");
  const head = rpcNumber(headHex as string);
  await client.query("UPDATE hoodball.indexer SET head_block=$1 WHERE id=1", [head]);
  if (state.halted) return true;
  if (indexed !== null && checkBlock(indexedBlock as Block | null, indexed).hash !== state.indexed_hash)
    throw new HistoryError(
      "Chain reorganization detected. Indexing and draws are paused pending a history rebuild.",
    );
  const from = indexed === null ? config.startBlock : indexed + 1;
  const target = Math.max(0, head - CONFIRMATIONS);
  if (from > target) {
    if (state.pending_verify && indexed !== null) {
      const supply = await verifyAgainstChain(client, { ...config, tokenAddress: token }, indexed, new Map(), true);
      const sum = (
        await client.query("SELECT COALESCE(sum(balance),0)::text AS balance FROM hoodball.holders")
      ).rows[0].balance;
      if (BigInt(sum) !== supply)
        throw new HistoryError(
          "Indexed balances do not match token total supply. Missing history or unsupported token mechanics; draws paused.",
        );
      await client.query(
        "UPDATE hoodball.indexer SET pending_verify=false,total_supply=$1 WHERE id=1",
        [supply.toString()],
      );
    }
    await client.query(
      "UPDATE hoodball.indexer SET phase=$1,error=NULL,last_synced_at=now() WHERE id=1",
      [indexed === null ? "syncing" : "live"],
    );
    return true;
  }
  const { logs, to } = await fetchLogs(token, from, target);
  logs.sort(
    (a, b) =>
      rpcNumber(a.blockNumber) - rpcNumber(b.blockNumber) ||
      rpcNumber(a.transactionIndex) - rpcNumber(b.transactionIndex) ||
      rpcNumber(a.logIndex) - rpcNumber(b.logIndex),
  );
  const heights = new Set<number>([to]);
  for (const log of logs) {
    const height = rpcNumber(log.blockNumber);
    if (log.removed || height < from || height > to || log.address.toLowerCase() !== token)
      throw new HistoryError("Inconsistent RPC transfer history");
    heights.add(height);
  }
  const blocks = await blocksAt([...heights]);
  const end = blocks.get(to)!;
  const decoded = [];
  const addresses = new Set<string>();
  for (const log of logs) {
    const height = rpcNumber(log.blockNumber);
    const block = blocks.get(height)!;
    if (block.hash !== log.blockHash)
      throw new HistoryError("Chain changed during transfer indexing");
    const { args } = decodeEventLog({ abi: [event], data: log.data, topics: log.topics });
    const fromAddress = args.from.toLowerCase();
    const toAddress = args.to.toLowerCase();
    if (fromAddress !== ZERO_ADDRESS) addresses.add(fromAddress);
    if (toAddress !== ZERO_ADDRESS) addresses.add(toAddress);
    decoded.push({
      log,
      fromAddress,
      toAddress,
      amount: args.value,
      timestamp: new Date(rpcNumber(block.timestamp) * 1000).toISOString(),
      height,
    });
  }
  const balances = new Map<string, BalanceState>();
  const contracts = new Map<string, boolean>();
  if (addresses.size) {
    const records = await client.query(
      "SELECT * FROM hoodball.holders WHERE address=ANY($1::text[])",
      [[...addresses]],
    );
    for (const row of records.rows) {
      balances.set(row.address, {
        balance: BigInt(row.balance),
        firstSeenAt: row.first_seen_at?.toISOString() ?? null,
      });
      contracts.set(row.address, row.is_contract);
    }
    const fresh = [...addresses].filter((address) => !contracts.has(address));
    const codes = await rpcBatch<string>(
      fresh.map((address) => ({ method: "eth_getCode", params: [address, "latest"] })),
    );
    fresh.forEach((address, i) => contracts.set(address, codes[i] !== "0x"));
  }
  for (const transfer of decoded) {
    try {
      applyTransfer(balances, transfer.fromAddress, transfer.toAddress, transfer.amount, transfer.timestamp);
    } catch (error) {
      throw new HistoryError(error instanceof Error ? error.message : "Invalid token history");
    }
  }
  let supply: bigint | null = null;
  if (head - to <= STATE_WINDOW) {
    try {
      supply = await verifyAgainstChain(
        client,
        { ...config, tokenAddress: token },
        to,
        balances,
        Boolean(state.pending_verify),
      );
    } catch (error) {
      if (!isStateUnavailable(error)) throw error;
    }
  }
  await client.query("BEGIN");
  try {
    for (let offset = 0; offset < decoded.length; offset += 500) {
      const batch = decoded.slice(offset, offset + 500).map((transfer) => ({
        tx_hash: transfer.log.transactionHash,
        log_index: rpcNumber(transfer.log.logIndex),
        block_number: transfer.height,
        block_hash: transfer.log.blockHash,
        from_address: transfer.fromAddress,
        to_address: transfer.toAddress,
        amount: transfer.amount.toString(),
        timestamp: transfer.timestamp,
      }));
      await client.query(
        `INSERT INTO hoodball.transfers(tx_hash,log_index,block_number,block_hash,from_address,to_address,amount,timestamp)
        SELECT tx_hash,log_index,block_number,block_hash,from_address,to_address,amount,timestamp FROM jsonb_to_recordset($1::jsonb)
        AS x(tx_hash text,log_index integer,block_number bigint,block_hash text,from_address text,to_address text,amount numeric,timestamp timestamptz)`,
        [JSON.stringify(batch)],
      );
    }
    const holderRows = [...balances].map(([address, value]) => ({
      address,
      balance: value.balance.toString(),
      first_seen_at: value.firstSeenAt,
      is_contract: contracts.get(address) ?? false,
      updated_block: to,
    }));
    for (let offset = 0; offset < holderRows.length; offset += 500) {
      await client.query(
        `INSERT INTO hoodball.holders(address,balance,first_seen_at,is_contract,updated_block)
        SELECT address,balance,first_seen_at,is_contract,updated_block FROM jsonb_to_recordset($1::jsonb)
        AS x(address text,balance numeric,first_seen_at timestamptz,is_contract boolean,updated_block bigint)
        ON CONFLICT(address) DO UPDATE SET balance=EXCLUDED.balance,
          first_seen_at=COALESCE(hoodball.holders.first_seen_at,EXCLUDED.first_seen_at),
          is_contract=EXCLUDED.is_contract,updated_block=EXCLUDED.updated_block`,
        [JSON.stringify(holderRows.slice(offset, offset + 500))],
      );
    }
    if (supply !== null) {
      const sum = (
        await client.query("SELECT COALESCE(sum(balance),0)::text AS balance FROM hoodball.holders")
      ).rows[0].balance;
      if (BigInt(sum) !== supply)
        throw new HistoryError(
          "Indexed balances do not match token total supply. Missing history or unsupported token mechanics; draws paused.",
        );
    }
    if ((await blockAt(to)).hash !== end.hash)
      throw new HistoryError("Chain changed before indexing commit");
    const live = to >= target;
    await client.query(
      `UPDATE hoodball.indexer SET indexed_block=$1,indexed_hash=$2,phase=$3,error=NULL,last_synced_at=now(),
        total_supply=COALESCE($4,total_supply),pending_verify=$5 WHERE id=1`,
      [to, end.hash, live ? "live" : "syncing", supply?.toString() ?? null, supply === null],
    );
    await client.query("COMMIT");
    return live;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}
export async function workerTick() {
  if (process.env.HOODBALL_WORKER_ENABLED === "false") {
    await refreshSnapshot();
    return;
  }
  if (running) return;
  running = true;
  let client: PoolClient | undefined;
  let locked = false;
  try {
    await ensureSchema();
    client = await pool().connect();
    locked = (
      await client.query("SELECT pg_try_advisory_lock(4663,76202) AS locked")
    ).rows[0].locked;
    if (!locked) return;
    await ensureVaultFromKey(client);
    const started = Date.now();
    caughtUp = await indexChunk(client);
    while (!caughtUp && Date.now() - started < TICK_BUDGET_MS) {
      void refreshSnapshot().catch(() => {});
      caughtUp = await indexChunk(client);
    }
    const status = (
      await client.query("SELECT phase,halted FROM hoodball.indexer WHERE id=1")
    ).rows[0];
    if (status.phase === "live" && !status.halted) {
      const config = await readConfig(client);
      if (config.tokenAddress)
        try {
          await refreshPools(client, config.tokenAddress);
        } catch (error) {
          console.error(
            "Pool discovery:",
            error instanceof Error ? error.message : "unknown",
          );
        }
      await runDraws(client);
    }
    try {
      await runTreasury(client);
    } catch (error) {
      console.error(
        "Hoodball treasury:",
        error instanceof Error ? error.message : "Unknown treasury error",
      );
    }
  } catch (error) {
    const message =
      error instanceof HistoryError
        ? error.message
        : "Chain service is temporarily unavailable; draws are paused until synchronized.";
    console.error(
      "Hoodball worker:",
      error instanceof Error ? error.message : "Unknown worker error",
    );
    if (client && locked)
      await client.query(
        "UPDATE hoodball.indexer SET phase='error',error=$1,halted=halted OR $2 WHERE id=1",
        [message, error instanceof HistoryError],
      );
  } finally {
    try {
      if (client) {
        try {
          if (locked) await client.query("SELECT pg_advisory_unlock(4663,76202)");
        } finally {
          client.release();
        }
      }
    } finally {
      running = false;
      await refreshSnapshot();
      void refreshSwapClassifications().catch((error) =>
        console.error("Swap classification:", error instanceof Error ? error.message : "unknown"),
      );
    }
  }
}
export function startWorker() {
  let stopped = false;
  const loop = async () => {
    try {
      await workerTick();
    } catch (error) {
      console.error("Worker loop failed:", error instanceof Error ? error.message : "unknown");
    }
    if (!stopped) timer = setTimeout(loop, caughtUp ? 1500 : 250);
  };
  void loop();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
