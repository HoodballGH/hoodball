import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionResult,
  erc20Abi,
  keccak256,
  parseEther,
  parseTransaction,
  toHex,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  aggregatorAbi,
  CHAINLINK_ETH_USD,
  MULTICALL3,
  multicall3Abi,
  PONS_FACTORY,
  UNISWAP_V3_FACTORY,
} from "../lib/pons";

const database = process.env.HOODBALL_TEST_DATABASE_URL;
type RpcArg = string & {
  to: string;
  data: string;
  topics: string[];
  fromBlock: string;
  toBlock: string;
};
const decodeCalls = (data: Hex) =>
  decodeFunctionData({ abi: multicall3Abi, data }).args as [
    readonly { target: Hex; allowFailure: boolean; callData: Hex }[],
  ];

test(
  "300 holders: pool and contract exclusion, rolled-over and paid draws, exact receipts, seed reveal, money gate, pause/resume",
  { skip: !database, timeout: 180000 },
  async () => {
    const token = "0x1111111111111111111111111111111111111111";
    const vaultKey = toHex(randomBytes(32));
    const vault = privateKeyToAccount(vaultKey).address.toLowerCase();
    const wallets = Array.from(
      { length: 300 },
      (_, i) => `0x${(0x20000 + i).toString(16).padStart(40, "0")}`,
    );
    const contracts = new Set(wallets.slice(0, 5));
    const poolAddress = wallets[5];
    let head = 1020;
    let vaultBalance = parseEther("0.0201");
    const accepted = new Map<
      string,
      { raw: Hex; block: number; nonce: number; to: string; value: bigint }
    >();
    const hash = (n: number): Hex => `0x${n.toString(16).padStart(64, "0")}`;
    const uint = (n: bigint) => encodeAbiParameters([{ type: "uint256" }], [n]);
    const addressResult = (value: string) =>
      encodeAbiParameters([{ type: "address" }], [value as Hex]);
    const topics = (from: string, to: string) =>
      encodeEventTopics({
        abi: erc20Abi,
        eventName: "Transfer",
        args: { from: from as Hex, to: to as Hex },
      });
    const roundData = encodeFunctionResult({
      abi: aggregatorAbi,
      functionName: "latestRoundData",
      result: [
        1n,
        3000n * 10n ** 8n,
        BigInt(Math.floor(Date.now() / 1000)),
        BigInt(Math.floor(Date.now() / 1000)),
        1n,
      ],
    });

     
    const handle = async ({
      id,
      method,
      params,
    }: {
      id: number;
      method: string;
      params: readonly unknown[];
    }): Promise<unknown> => {
      let result: unknown;
      try {
        const args = params as RpcArg[];
        if (method === "eth_chainId") result = toHex(4663);
        else if (method === "eth_blockNumber") result = toHex(head);
        else if (method === "eth_getBlockByNumber") {
          const n = Number(BigInt(args[0]));
          result = {
            number: toHex(n),
            hash: hash(n),
            timestamp: toHex(Math.floor(Date.now() / 1000) - 7200 + n - 1000),
          };
        } else if (method === "eth_getCode") {
          const target = args[0].toLowerCase();
          const tag = args[1] as unknown as string;
          const deployed =
            typeof tag !== "string" || !tag.startsWith("0x") || Number(BigInt(tag)) >= 1000;
          result =
            (target === token && deployed) || contracts.has(target) ? "0x6000" : "0x";
        } else if (method === "eth_getLogs") {
          const filter = args[0];
          result =
            filter.topics?.length > 1
              ? []
              : Number(BigInt(filter.fromBlock)) <= 1000 &&
                  Number(BigInt(filter.toBlock)) >= 1000
                ? wallets.map((wallet, i) => ({
                    address: token,
                    blockNumber: toHex(1000),
                    blockHash: hash(1000),
                    transactionHash: hash(1000000 + i),
                    transactionIndex: toHex(i),
                    logIndex: toHex(i),
                    data: uint(BigInt(i + 1) * 10n ** 18n),
                    topics: topics(
                      "0x0000000000000000000000000000000000000000",
                      wallet,
                    ),
                  }))
                : [];
        } else if (method === "eth_call") {
          const data = args[0].data as string;
          const to = args[0].to.toLowerCase();
          if (
            to === MULTICALL3.toLowerCase() &&
            data.startsWith("0x82ad56cb")
          ) {
            const [calls] = decodeCalls(data as Hex);
            const inner = await Promise.all(
              calls.map(async (call) => {
                const response = (await handle({
                  id: 0,
                  method: "eth_call",
                  params: [{ to: call.target, data: call.callData }, args[1]],
                })) as { result?: Hex; error?: unknown };
                if (response.error)
                  return { success: false, returnData: "0x" as Hex };
                return { success: true, returnData: response.result! };
              }),
            );
            result = encodeFunctionResult({
              abi: multicall3Abi,
              functionName: "aggregate3",
              result: inner,
            });
          } else if (to === CHAINLINK_ETH_USD.toLowerCase()) result = roundData;
          else if (to === UNISWAP_V3_FACTORY.toLowerCase())
            // token × WETH at the 3000 tier is the only live pool
            result = data.endsWith("bb8")
              ? addressResult(poolAddress)
              : addressResult("0x0000000000000000000000000000000000000000");
          else if (to === PONS_FACTORY.toLowerCase())
            result = `0x${"0".repeat(64 * 15)}`;
          else if (data.startsWith("0x18160ddd"))
            result = uint(
              wallets.reduce((sum, _, i) => sum + BigInt(i + 1), 0n) *
                10n ** 18n,
            );
          else if (data.startsWith("0x313ce567")) result = uint(18n);
          else if (data.startsWith("0x95d89b41"))
            result = encodeAbiParameters([{ type: "string" }], ["HOODBALL"]);
          else if (data.startsWith("0x06fdde03"))
            result = encodeAbiParameters([{ type: "string" }], ["Hoodball"]);
          else if (data.startsWith("0x70a08231")) {
            const holder = `0x${data.slice(-40)}`.toLowerCase();
            const index = wallets.indexOf(holder);
            result = uint(index < 0 ? 0n : BigInt(index + 1) * 10n ** 18n);
          } else result = uint(1n);
        } else if (method === "eth_getTransactionCount") {
          const confirmed = [...accepted.values()].filter(
            (tx) => tx.block + 12 <= head,
          );
          result = toHex(
            args[1] === "pending" ? accepted.size : confirmed.length,
          );
        } else if (method === "eth_gasPrice") result = "0x1";
        else if (method === "eth_getBalance")
          result = toHex(args[0].toLowerCase() === vault ? vaultBalance : 0n);
        else if (method === "eth_estimateGas") result = toHex(60000);
        else if (method === "eth_sendRawTransaction") {
          const raw = args[0] as Hex;
          const tx = parseTransaction(raw);
          const txHash = keccak256(raw);
          if (!accepted.has(txHash))
            accepted.set(txHash, {
              raw,
              block: head,
              nonce: tx.nonce!,
              to: tx.to!.toLowerCase(),
              value: tx.value!,
            });
          result = txHash;
        } else if (method === "eth_getTransactionByHash") {
          const tx = accepted.get(args[0]);
          result = tx
            ? {
                hash: args[0],
                from: vault,
                to: tx.to,
                value: toHex(tx.value),
              }
            : null;
        } else if (method === "eth_getTransactionReceipt") {
          const tx = accepted.get(args[0]);
          result = tx
            ? {
                status: "0x1",
                blockNumber: toHex(tx.block),
                blockHash: hash(tx.block),
                to: tx.to,
                logs: [],
              }
            : null;
        } else throw new Error(`Unhandled method ${method}`);
        return { jsonrpc: "2.0", id, result };
      } catch (error) {
        return {
          jsonrpc: "2.0",
          id,
          error: { code: -32000, message: String(error) },
        };
      }
    };

    const rpcServer = createServer(async (request, response) => {
      let body = "";
      for await (const chunk of request) body += chunk;
      const parsed = JSON.parse(body);
      const out = Array.isArray(parsed)
        ? await Promise.all(parsed.map(handle))
        : await handle(parsed);
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(out));
    });
    await new Promise<void>((resolve) =>
      rpcServer.listen(0, "127.0.0.1", resolve),
    );
    const endpoint = rpcServer.address();
    assert(endpoint && typeof endpoint === "object");
    process.env.DATABASE_URL = database;
    process.env.ROBINHOOD_RPC_URL = `http://127.0.0.1:${endpoint.port}`;
    process.env.MONEY_ENABLED = "false";
    process.env.HOODBALL_VAULT_PRIVATE_KEY = vaultKey;
    process.env.HOODBALL_TREASURY_INTERVAL_SECONDS = "0";
    delete process.env.HOODBALL_WORKER_ENABLED;

    const { pool, ensureSchema } = await import("../lib/db");
    const { updateConfig } = await import("../lib/config");
    const { workerTick } = await import("../lib/indexer");
    const { getSnapshot, refreshSnapshot } = await import("../lib/snapshot");
    const { createDraw, gateFor } = await import("../lib/draws");
    const releaseCycle = () =>
      pool().query("UPDATE hoodball.draws SET cycle_id = cycle_id - 1");
    const drawRows = async () =>
      (
        await pool().query(
          "SELECT id,cycle_id,status,pot_wei,seed,seed_hash,revealed_at,skip_reason FROM hoodball.draws ORDER BY cycle_id",
        )
      ).rows;
    const payoutRows = async () =>
      (
        await pool().query(
          "SELECT id,draw_id,recipient,amount_wei,status,tx_hash,raw_tx,nonce,confirmed_at FROM hoodball.draw_payouts ORDER BY created_at",
        )
      ).rows;

    try {
      await ensureSchema();
      await pool().query(
        "TRUNCATE hoodball.draw_payouts, hoodball.draws, hoodball.transfers, hoodball.tx_classifications, hoodball.holders, hoodball.pools, hoodball.treasury_ops, hoodball.treasury_income, hoodball.treasury_cursor, hoodball.treasury_state, hoodball.price_points",
      );
      await pool().query(
        "UPDATE hoodball.runtime_config SET config = config - 'tokenAddress' - 'startBlock' - 'vaultAddress' WHERE id=1",
      );
      await pool().query(
        "UPDATE hoodball.indexer SET indexed_block=NULL,indexed_hash=NULL,phase='prelaunch',error=NULL,halted=false,total_supply=NULL,pending_verify=false WHERE id=1",
      );

      const config = await updateConfig({
        tokenAddress: token,
        vaultAddress: vault,
        drawIntervalSeconds: 300,
        winnersPerDraw: 1,
      });
      assert.equal(config.tokenSymbol, "HOODBALL");
      assert.equal(
        config.startBlock,
        1000,
        "contract-only configuration discovers the exact deployment block",
      );

      await workerTick();
      let snapshot = await getSnapshot();
      assert.equal(snapshot.chain.status, "live");
      assert.equal(snapshot.stats.holders, 300);
      assert.equal(
        snapshot.stats.eligibleHolders,
        294,
        "5 contracts and 1 discovered pool must be excluded",
      );
      assert.equal(
        (
          await pool().query("SELECT 1 FROM hoodball.pools WHERE address=$1", [
            poolAddress,
          ])
        ).rowCount,
        1,
        "the Uniswap V3 pool is recorded",
      );
      assert.equal(snapshot.draws.gate, "money_disabled");
      assert.equal(accepted.size, 0, "the money gate must prevent every send");
      assert.equal((await drawRows()).length, 0);

      // --- rolled over: the pot is below the minimum -------------------------
      process.env.MONEY_ENABLED = "true";
      await workerTick();
      let draws = await drawRows();
      assert.equal(draws.length, 1);
      assert.equal(draws[0].status, "rolled_over");
      assert.equal(draws[0].seed_hash, null);
      assert.match(draws[0].skip_reason, /below the minimum/);
      assert.equal(accepted.size, 0, "a rolled-over draw sends nothing");

      // --- duplicate cycle protection ---------------------------------------
      await workerTick();
      assert.equal(
        (await drawRows()).length,
        1,
        "a second tick inside the same cycle must not create a second draw",
      );
      const client = await pool().connect();
      try {
        const { readConfig } = await import("../lib/db");
        const duplicate = await createDraw(
          client,
          await readConfig(client),
          Number(draws[0].cycle_id),
          1008,
          parseEther("5"),
        );
        assert.equal(duplicate, "duplicate");
      } finally {
        client.release();
      }

      // --- paused: no draw even when a cycle is due -------------------------
      await releaseCycle();
      await updateConfig({ drawsEnabled: false });
      await workerTick();
      assert.equal((await drawRows()).length, 1, "a paused draw is not run");
      await refreshSnapshot();
      assert.equal((await getSnapshot()).draws.gate, "paused");
      await updateConfig({ drawsEnabled: true });

      // --- paid: a funded vault pays one winner ------------------------------
      vaultBalance = parseEther("1");
      await workerTick();
      draws = await drawRows();
      assert.equal(draws.length, 2, "resuming runs the due cycle");
      const paidDraw = draws.find((row) => row.status === "scheduled");
      assert.ok(
        paidDraw,
        "the funded draw is scheduled until its payout lands",
      );
      assert.match(paidDraw.seed_hash, /^0x[0-9a-f]{64}$/);
      assert.equal(paidDraw.revealed_at, null);
      assert.equal(
        BigInt(paidDraw.pot_wei),
        parseEther("1") - parseEther("0.02"),
        "the pot is the vault balance minus the gas reserve",
      );
      let payouts = await payoutRows();
      assert.equal(payouts.length, 1);
      assert.equal(payouts[0].status, "submitted");
      assert.match(payouts[0].raw_tx, /^0x/);
      assert.equal(
        BigInt(payouts[0].amount_wei),
        BigInt(paidDraw.pot_wei),
        "a single winner takes the whole pot",
      );
      assert.equal(accepted.size, 1);
      const sent = [...accepted.values()][0];
      assert.equal(sent.to, payouts[0].recipient);
      assert.equal(sent.value, BigInt(payouts[0].amount_wei));
      assert.ok(
        !contracts.has(sent.to) && sent.to !== poolAddress,
        "a contract or pool can never be paid",
      );

      // the seed stays hidden while the payout is in flight
      await refreshSnapshot();
      snapshot = await getSnapshot();
      const pendingDraw = snapshot.recentDraws.find(
        (draw) => draw.id === paidDraw.id,
      )!;
      assert.equal(pendingDraw.seed, null);
      assert.equal(pendingDraw.seedHash, paidDraw.seed_hash);
      assert.equal(snapshot.draws.pending.submitted, 1);

      // --- reconcile with an exact receipt, then reveal the seed -------------
      head += 20;
      await workerTick();
      payouts = await payoutRows();
      assert.equal(payouts[0].status, "confirmed");
      assert.ok(payouts[0].confirmed_at);
      draws = await drawRows();
      const settled = draws.find((row) => row.id === paidDraw.id)!;
      assert.equal(settled.status, "paid");
      assert.ok(
        settled.revealed_at,
        "the seed is revealed once payouts settle",
      );
      assert.equal(keccak256(settled.seed as Hex), settled.seed_hash);

      await refreshSnapshot();
      snapshot = await getSnapshot();
      const revealed = snapshot.recentDraws.find(
        (draw) => draw.id === paidDraw.id,
      )!;
      assert.equal(revealed.seed, settled.seed);
      assert.equal(revealed.status, "paid");
      assert.equal(revealed.payouts[0].status, "confirmed");
      assert.equal(snapshot.stats.drawsPaid, 1);
      assert.equal(snapshot.draws.totalPaidWei, payouts[0].amount_wei);
      assert.equal(
        snapshot.activity.filter((entry) => entry.type === "payout").length,
        1,
        "a confirmed payout shows in the public activity feed",
      );

      // --- no duplicate payout on restart ------------------------------------
      const before = accepted.size;
      await workerTick();
      assert.equal(accepted.size, before, "a restart must not repay a winner");

      // --- the gate reflects a missing vault key -----------------------------
      const key = process.env.HOODBALL_VAULT_PRIVATE_KEY;
      delete process.env.HOODBALL_VAULT_PRIVATE_KEY;
      assert.equal(gateFor(config, "live", true), "no_vault_key");
      process.env.HOODBALL_VAULT_PRIVATE_KEY = key;
      assert.equal(gateFor(config, "live", false), "unsupported_quote");
      assert.equal(gateFor(config, "syncing", true), "indexer_not_live");
      assert.equal(gateFor(config, "live", true), "ok");
    } finally {
      await pool().end();
      rpcServer.closeAllConnections();
      await new Promise<void>((resolve) => rpcServer.close(() => resolve()));
    }
  },
);
