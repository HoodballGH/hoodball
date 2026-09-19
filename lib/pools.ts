import type { PoolClient } from "pg";
import { decodeFunctionResult, encodeFunctionData, type Hex } from "viem";
import { ZERO_ADDRESS } from "./chain";
import {
  describeLaunch,
  FEE_TIERS,
  multicall,
  uniswapFactoryAbi,
  UNISWAP_V3_FACTORY,
  USDG,
  WETH,
} from "./pons";

const CACHE_MS = 600_000;
let cache: { key: string; at: number } | null = null;

export type PoolRecord = {
  address: string;
  source: string;
  pairToken: string | null;
  fee: number | null;
};

export async function recordPools(client: PoolClient, pools: PoolRecord[]) {
  if (!pools.length) return;
  await client.query(
    `INSERT INTO hoodball.pools(address,source,pair_token,fee)
     SELECT address,source,pair_token,fee FROM jsonb_to_recordset($1::jsonb)
     AS x(address text,source text,pair_token text,fee integer)
     ON CONFLICT(address) DO NOTHING`,
    [
      JSON.stringify(
        pools.map((entry) => ({
          address: entry.address.toLowerCase(),
          source: entry.source,
          pair_token: entry.pairToken?.toLowerCase() ?? null,
          fee: entry.fee,
        })),
      ),
    ],
  );
}

export async function listPools(client: PoolClient): Promise<Set<string>> {
  const rows = await client.query("SELECT address FROM hoodball.pools");
  return new Set(rows.rows.map((row) => row.address.toLowerCase()));
}

/**
 * Discovers the venues a holder balance can sit in without being a real holder:
 * the Pons bonding curve plus every Uniswap V3 pool for token×WETH and
 * token×USDG across all fee tiers. One multicall, cached for ten minutes.
 */
export async function refreshPools(
  client: PoolClient,
  token: string,
  force = false,
) {
  const key = token.toLowerCase();
  if (!force && cache && cache.key === key && Date.now() - cache.at < CACHE_MS)
    return;
  const found: PoolRecord[] = [];
  const launch = await describeLaunch(token);
  if (launch.launched && launch.curve && launch.curve !== ZERO_ADDRESS)
    found.push({
      address: launch.curve,
      source: "pons-curve",
      pairToken: launch.isNativeQuote ? null : launch.pairToken,
      fee: null,
    });
  const pairs = [WETH, USDG];
  const combinations = pairs.flatMap((pair) =>
    FEE_TIERS.map((fee) => ({ pair, fee })),
  );
  const results = await multicall(
    combinations.map(({ pair, fee }) => ({
      target: UNISWAP_V3_FACTORY,
      data: encodeFunctionData({
        abi: uniswapFactoryAbi,
        functionName: "getPool",
        args: [token as Hex, pair as Hex, fee],
      }),
    })),
  );
  results.forEach((result, index) => {
    if (!result.success || result.data === "0x") return;
    let address: string;
    try {
      address = decodeFunctionResult({
        abi: uniswapFactoryAbi,
        functionName: "getPool",
        data: result.data,
      }).toLowerCase();
    } catch {
      return;
    }
    if (address === ZERO_ADDRESS) return;
    found.push({
      address,
      source: "uniswap-v3",
      pairToken: combinations[index].pair,
      fee: combinations[index].fee,
    });
  });
  await recordPools(client, found);
  cache = { key, at: Date.now() };
}

export function resetPoolCache() {
  cache = null;
}
