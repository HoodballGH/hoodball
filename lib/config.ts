import { timingSafeEqual } from "node:crypto";
import {
  decodeFunctionResult,
  encodeFunctionData,
  erc20Abi,
  isAddress,
} from "viem";
import { z } from "zod";
import { CONFIRMATIONS, DEAD_ADDRESS, ZERO_ADDRESS } from "./chain";
import { ensureSchema, pool, readConfig } from "./db";
import { assertChain, blockTag, rpc, rpcNumber } from "./rpc";
import type { RuntimeConfig } from "./types";

const address = z
  .string()
  .refine(
    (value) =>
      isAddress(value, { strict: false }) &&
      ![ZERO_ADDRESS, DEAD_ADDRESS].includes(value.toLowerCase()),
    "Expected a nonzero EVM address",
  )
  .transform((value) => value.toLowerCase());
const decimalAmount = z
  .string()
  .regex(/^(?:0|[1-9]\d*)(?:\.\d{1,36})?$/, "Expected a decimal token amount")
  .max(80);
const schema = z
  .object({
    tokenAddress: address.nullable().optional(),
    startBlock: z
      .number()
      .int()
      .min(0)
      .max(Number.MAX_SAFE_INTEGER)
      .nullable()
      .optional(),
    vaultAddress: address.nullable().optional(),
    excludedAddresses: z.array(address).max(1000).optional(),
    drawsEnabled: z.boolean().optional(),
    drawIntervalSeconds: z.number().int().min(300).max(604800).optional(),
    winnersPerDraw: z.number().int().min(1).max(10).optional(),
    minBalance: decimalAmount.optional(),
    twitterUrl: z
      .string()
      .url()
      .refine((value) => {
        const url = new URL(value);
        return (
          url.protocol === "https:" &&
          ["x.com", "twitter.com", "www.x.com", "www.twitter.com"].includes(
            url.hostname,
          ) &&
          !url.username &&
          !url.password
        );
      }, "Expected an https://x.com profile URL")
      .nullable()
      .optional(),
  })
  .strict();

export class ConfigError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}

export function authorized(request: Request) {
  const token = process.env.HOODBALL_ADMIN_TOKEN;
  if (!token || token.length < 32) return false;
  const given = request.headers.get("authorization") ?? "";
  const expected = `Bearer ${token}`;
  const actualBytes = Buffer.from(given);
  const expectedBytes = Buffer.from(expected);
  return (
    actualBytes.length === expectedBytes.length &&
    timingSafeEqual(actualBytes, expectedBytes)
  );
}

async function tokenMetadata(token: string, at = "latest") {
  const target = token as `0x${string}`;
  const call = async (functionName: "decimals" | "symbol" | "name") =>
    rpc<`0x${string}`>("eth_call", [
      { to: target, data: encodeFunctionData({ abi: erc20Abi, functionName }) },
      at,
    ]);
  const decimals = decodeFunctionResult({
    abi: erc20Abi,
    functionName: "decimals",
    data: await call("decimals"),
  });
  const symbol = decodeFunctionResult({
    abi: erc20Abi,
    functionName: "symbol",
    data: await call("symbol"),
  });
  const name = decodeFunctionResult({
    abi: erc20Abi,
    functionName: "name",
    data: await call("name"),
  });
  if (
    decimals > 36 ||
    !symbol ||
    symbol.length > 20 ||
    !name ||
    name.length > 100
  )
    throw new ConfigError("Unsupported token metadata");
  return { decimals, symbol, name };
}

const TRANSFER_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
/** Largest eth_getLogs span the RPC serves (QuickNode enforces 10,000 blocks). */
export const LOG_RANGE = Math.max(
  1000,
  Math.min(10000, Number(process.env.HOODBALL_INDEX_WINDOW ?? 10000) || 10000),
);
const DISCOVERY_WINDOWS = 30;

async function hasCode(token: string, block: number) {
  return (await rpc<string>("eth_getCode", [token, blockTag(block)])) !== "0x";
}

/**
 * First block at which the token contract has code, by binary search over
 * archive `eth_getCode`. The RPC caps eth_getLogs at LOG_RANGE blocks, so the
 * old whole-history log scan can never work here; code presence is monotonic
 * and needs ~26 point reads for the full chain height.
 */
export async function deploymentBlock(
  token: string,
  upTo: number,
): Promise<number> {
  if (!(await hasCode(token, upTo)))
    throw new ConfigError("Token is not deployed yet");
  let low = 0;
  let high = upTo;
  try {
    if (await hasCode(token, 0)) return 0;
  } catch {
    throw new ConfigError(
      "RPC cannot serve historical contract state; pass startBlock explicitly",
    );
  }
  while (high - low > 1) {
    const mid = low + Math.floor((high - low) / 2);
    if (await hasCode(token, mid)) high = mid;
    else low = mid;
  }
  return high;
}

/** First Transfer at or after `from`, scanning forward in RPC-sized windows. */
export async function firstTransferBlock(
  token: string,
  from: number,
  upTo: number,
): Promise<number | null> {
  for (let window = 0, start = from; window < DISCOVERY_WINDOWS && start <= upTo; window++) {
    const end = Math.min(upTo, start + LOG_RANGE - 1);
    const logs = await rpc<{ blockNumber: string }[]>("eth_getLogs", [
      {
        address: token,
        fromBlock: blockTag(start),
        toBlock: blockTag(end),
        topics: [TRANSFER_TOPIC],
      },
    ]);
    if (!Array.isArray(logs)) throw new Error("Malformed RPC logs");
    if (logs.length)
      return Math.min(...logs.map((log) => rpcNumber(log.blockNumber)));
    start = end + 1;
  }
  return null;
}

export async function updateConfig(input: unknown): Promise<RuntimeConfig> {
  const parsed = schema.safeParse(input);
  if (!parsed.success)
    throw new ConfigError(
      parsed.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("; "),
    );
  if (!Object.keys(parsed.data).length)
    throw new ConfigError("No configuration fields supplied");
  await ensureSchema();
  const client = await pool().connect();
  let locked = false;
  try {
    // The worker holds this lock for a whole tick (up to 40 s while syncing), so a
    // try-lock would refuse almost every request; queue behind it instead.
    await client.query("SET statement_timeout = 90000");
    try {
      await client.query("SELECT pg_advisory_lock(4663,76202)");
      locked = true;
    } catch {
      throw new ConfigError(
        "Worker is processing a draw; retry configuration shortly",
        409,
      );
    } finally {
      await client.query("SET statement_timeout = 0").catch(() => {});
    }
    const fields = Object.keys(parsed.data);
    const pauseOnly =
      fields.length === 1 && typeof parsed.data.drawsEnabled === "boolean";
    if (
      !pauseOnly &&
      (
        await client.query(
          "SELECT 1 FROM hoodball.draw_payouts WHERE status IN ('queued','signed','submitted','review') LIMIT 1",
        )
      ).rowCount
    )
      throw new ConfigError(
        "A draw payout is pending. Configuration is locked until its transactions resolve; draws can still be paused or resumed.",
        409,
      );
    const previous = await readConfig(client);
    const next: RuntimeConfig = { ...previous, ...parsed.data };
    if (
      previous.tokenAddress &&
      (next.tokenAddress !== previous.tokenAddress ||
        next.startBlock !== previous.startBlock)
    )
      throw new ConfigError(
        "The configured token and deployment block are immutable. A history migration requires an offline database review.",
        409,
      );
    await assertChain();
    if (
      next.tokenAddress &&
      !previous.tokenAddress &&
      parsed.data.startBlock === undefined
    ) {
      const finalized =
        rpcNumber(await rpc<string>("eth_blockNumber")) - CONFIRMATIONS;
      if (
        finalized < 0 ||
        (await rpc<string>("eth_getCode", [next.tokenAddress, "latest"])) ===
          "0x"
      )
        throw new ConfigError("Token is not deployed yet");
      const deployed = await deploymentBlock(next.tokenAddress, finalized);
      const first = await firstTransferBlock(
        next.tokenAddress,
        deployed,
        finalized,
      );
      if (first === null)
        throw new ConfigError(
          "Token has no confirmed Transfer events yet; retry after the first mint has 12 confirmations",
        );
      next.startBlock = deployed;
    }
    if ((next.tokenAddress === null) !== (next.startBlock === null))
      throw new ConfigError(
        "tokenAddress and its exact deployment startBlock must be provided together",
      );
    if (next.vaultAddress && next.vaultAddress === next.tokenAddress)
      throw new ConfigError("Vault must differ from the token contract");
    if (
      next.excludedAddresses.some(
        (value, index) => next.excludedAddresses.indexOf(value) !== index,
      )
    )
      throw new ConfigError("Excluded addresses must be unique");
    if (next.tokenAddress && !previous.tokenAddress) {
      const head = rpcNumber(await rpc<string>("eth_blockNumber"));
      if (next.startBlock! > head - CONFIRMATIONS)
        throw new ConfigError(
          "Token deployment needs 12 confirmations before configuration",
        );
      if (
        (await rpc<string>("eth_getCode", [next.tokenAddress, "latest"])) ===
        "0x"
      )
        throw new ConfigError("Token contract is not deployed");
      if (next.startBlock! > 0 && (await hasCode(next.tokenAddress, next.startBlock! - 1)))
        throw new ConfigError(
          "startBlock must not be later than the token's deployment block so all holder history is indexed",
        );
      const metadata = await tokenMetadata(next.tokenAddress);
      next.tokenDecimals = metadata.decimals;
      next.tokenName = metadata.name;
      next.tokenSymbol = metadata.symbol;
    }
    if ((next.minBalance.split(".")[1]?.length ?? 0) > next.tokenDecimals)
      throw new ConfigError(
        "minBalance has more decimals than the token supports",
      );
    await client.query("BEGIN");
    try {
      await client.query(
        "UPDATE hoodball.runtime_config SET config=$1,updated_at=now() WHERE id=1",
        [JSON.stringify(next)],
      );
      await client.query(
        "INSERT INTO hoodball.config_audit(changed_fields) VALUES($1)",
        [Object.keys(parsed.data)],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
    return next;
  } finally {
    try {
      if (locked) await client.query("SELECT pg_advisory_unlock(4663,76202)");
    } finally {
      client.release();
    }
  }
}
