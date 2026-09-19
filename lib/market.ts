import type { PoolClient } from "pg";
import { decodeFunctionResult, formatUnits } from "viem";
import { ZERO_ADDRESS } from "./chain";
import {
  curveAbi,
  curveCall,
  curveMetrics,
  describeLaunch,
  multicall,
  type LaunchInfo,
} from "./pons";
import { ethUsd, quoteUsd, readOnlyMode } from "./prices";
import { externalFetch } from "./rpc";
import type { MarketData, RuntimeConfig } from "./types";

export const PRICE_POINT_MS = 60_000;
export const PRICE_RETENTION_DAYS = 8;
const FIXTURE_PROGRESS = 0.62;
const FIXTURE_THRESHOLD_ETH = 4.2;
const intervalMs = () =>
  Math.max(3, Number(process.env.HOODBALL_MARKET_INTERVAL_SECONDS ?? 10) || 10) *
  1000;
let cache: { key: string; at: number; data: MarketData } | null = null;
let inflight: Promise<MarketData> | null = null;

export function emptyMarket(
  phase: MarketData["phase"] = "prelaunch",
  error: string | null = null,
): MarketData {
  return {
    source: "none",
    phase,
    curveAddress: null,
    pairSymbol: null,
    priceEth: null,
    priceUsd: null,
    marketCapUsd: null,
    marketCapEth: null,
    ethUsd: null,
    progress: null,
    raisedEth: null,
    graduationThresholdEth: null,
    launchSupply: null,
    volume24hUsd: null,
    priceChange24hPct: null,
    liquidityUsd: null,
    sparkline: [],
    updatedAt: new Date().toISOString(),
    error,
  };
}

export type PricePoint = {
  ts: string;
  priceUsd: number | null;
  marketCapUsd: number | null;
};
export function downsample<T>(points: T[], max: number): T[] {
  if (max < 1) return [];
  if (points.length <= max) return points;
  const out: T[] = [];
  const step = (points.length - 1) / (max - 1);
  for (let i = 0; i < max; i++) out.push(points[Math.round(i * step)]);
  return out;
}

type ApiQuote = {
  source: "pons-api" | "dexscreener";
  priceUsd: number;
  marketCapUsd: number | null;
  liquidityUsd: number | null;
  volume24hUsd: number | null;
  priceChange24hPct: number | null;
  pairSymbol: string | null;
};
const finite = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value)
    ? value
    : typeof value === "string" &&
        value.trim() !== "" &&
        Number.isFinite(Number(value))
      ? Number(value)
      : null;
export type DexPair = {
  chainId?: string;
  baseToken?: { address?: string };
  quoteToken?: { symbol?: string };
  priceUsd?: string | number;
  marketCap?: number;
  fdv?: number;
  liquidity?: { usd?: number };
  volume?: { h24?: number };
  priceChange?: { h24?: number };
};
export function pickDexPair(pairs: DexPair[], token: string): ApiQuote | null {
  const best = pairs
    .filter(
      (pair) =>
        pair.chainId === "robinhood" &&
        pair.baseToken?.address?.toLowerCase() === token.toLowerCase() &&
        (finite(pair.priceUsd) ?? 0) > 0,
    )
    .sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0];
  if (!best) return null;
  return {
    source: "dexscreener",
    priceUsd: finite(best.priceUsd)!,
    marketCapUsd: finite(best.marketCap) ?? finite(best.fdv),
    liquidityUsd: finite(best.liquidity?.usd),
    volume24hUsd: finite(best.volume?.h24),
    priceChange24hPct: finite(best.priceChange?.h24),
    pairSymbol: best.quoteToken?.symbol ?? null,
  };
}
async function fetchJson(url: string): Promise<unknown> {
  const response = await externalFetch(url, {
    headers: {
      accept: "application/json",
      "user-agent": "Mozilla/5.0 (Hoodball market reader)",
    },
    timeoutMs: 10000,
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}
async function fetchPonsMarket(token: string): Promise<ApiQuote | null> {
  try {
    const body = (await fetchJson(
      `https://www.ponsfamily.com/api/pons-market/${token}`,
    )) as Record<string, unknown> | null;
    if (!body || typeof body !== "object" || ("error" in body && body.error))
      return null;
    const priceUsd = finite(body.priceUsd);
    if (priceUsd === null || priceUsd <= 0) return null;
    return {
      source: "pons-api",
      priceUsd,
      marketCapUsd: finite(body.marketCapUsd),
      liquidityUsd: finite(body.liquidityUsd),
      volume24hUsd: finite(body.volume24hUsd),
      priceChange24hPct: finite(body.changePct ?? body.priceChange24h),
      pairSymbol: null,
    };
  } catch {
    return null;
  }
}
async function fetchDexscreener(token: string): Promise<ApiQuote | null> {
  try {
    const body = (await fetchJson(
      `https://api.dexscreener.com/latest/dex/tokens/${token}`,
    )) as { pairs?: DexPair[] } | null;
    return pickDexPair(body?.pairs ?? [], token);
  } catch {
    return null;
  }
}

async function readCurve(
  launch: LaunchInfo,
  quoteSymbol: string,
  quoteDecimals: number,
): Promise<MarketData> {
  const curve = launch.curve!;
  const results = await multicall([
    curveCall(curve, "getReserves"),
    curveCall(curve, "realQuoteReserve"),
    curveCall(curve, "graduationThreshold"),
    curveCall(curve, "launchSupply"),
  ]);
  if (results.some((result) => !result.success))
    throw new Error("Curve state read failed");
  const [quoteReserve, tokenReserve] = decodeFunctionResult({
    abi: curveAbi,
    functionName: "getReserves",
    data: results[0].data,
  });
  const realQuoteReserve = decodeFunctionResult({
    abi: curveAbi,
    functionName: "realQuoteReserve",
    data: results[1].data,
  });
  const graduationThreshold = decodeFunctionResult({
    abi: curveAbi,
    functionName: "graduationThreshold",
    data: results[2].data,
  });
  const launchSupply = decodeFunctionResult({
    abi: curveAbi,
    functionName: "launchSupply",
    data: results[3].data,
  });
  const metrics = curveMetrics({
    quoteReserve,
    tokenReserve,
    realQuoteReserve,
    graduationThreshold,
    launchSupply,
    quoteDecimals,
  });
  const usdPerQuote = await quoteUsd(quoteSymbol);
  const eth = launch.isNativeQuote ? usdPerQuote : await ethUsd();
  const priceUsd =
    metrics.priceQuote === null || usdPerQuote === null
      ? null
      : metrics.priceQuote * usdPerQuote;
  const marketCapUsd =
    metrics.marketCapQuote === null || usdPerQuote === null
      ? null
      : metrics.marketCapQuote * usdPerQuote;
  return {
    ...emptyMarket("curve"),
    source: "curve",
    curveAddress: curve,
    pairSymbol: quoteSymbol,
    priceEth: launch.isNativeQuote
      ? metrics.priceQuote
      : priceUsd !== null && eth
        ? priceUsd / eth
        : null,
    priceUsd,
    marketCapUsd,
    marketCapEth: launch.isNativeQuote
      ? metrics.marketCapQuote
      : marketCapUsd !== null && eth
        ? marketCapUsd / eth
        : null,
    ethUsd: eth,
    progress: metrics.progress,
    raisedEth: launch.isNativeQuote ? metrics.raisedQuote : null,
    graduationThresholdEth: launch.isNativeQuote
      ? metrics.thresholdQuote
      : null,
    launchSupply: formatUnits(launchSupply, 18),
  };
}

async function readPool(
  launch: LaunchInfo,
  quoteSymbol: string,
  totalSupply: string | null,
): Promise<MarketData> {
  const phase: MarketData["phase"] =
    launch.phaseName === "graduating" ? "graduating" : "pool";
  const quote =
    (await fetchPonsMarket(launch.token)) ??
    (await fetchDexscreener(launch.token));
  const eth = await ethUsd();
  if (!quote)
    return {
      ...emptyMarket(phase),
      curveAddress: launch.curve,
      pairSymbol: quoteSymbol,
      ethUsd: eth,
      progress: 1,
      error: "Post-graduation price feed is temporarily unavailable",
    };
  const supply = totalSupply === null ? null : Number(totalSupply);
  const marketCapUsd =
    supply !== null && Number.isFinite(supply)
      ? quote.priceUsd * supply
      : quote.marketCapUsd;
  return {
    ...emptyMarket(phase),
    source: quote.source,
    curveAddress: launch.curve,
    pairSymbol: quote.pairSymbol ?? quoteSymbol,
    priceEth: eth ? quote.priceUsd / eth : null,
    priceUsd: quote.priceUsd,
    marketCapUsd,
    marketCapEth: eth && marketCapUsd !== null ? marketCapUsd / eth : null,
    ethUsd: eth,
    progress: 1,
    volume24hUsd: quote.volume24hUsd,
    priceChange24hPct: quote.priceChange24hPct,
    liquidityUsd: quote.liquidityUsd,
    launchSupply: totalSupply,
  };
}

async function persistPoint(client: PoolClient, market: MarketData) {
  if (market.priceUsd === null || market.source === "none") return;
  await client.query(
    `INSERT INTO hoodball.price_points(ts,price_usd,market_cap_usd,source) SELECT now(),$1,$2,$3
     WHERE NOT EXISTS (SELECT 1 FROM hoodball.price_points WHERE ts > now() - make_interval(secs => $4))`,
    [
      market.priceUsd,
      market.marketCapUsd,
      market.source,
      PRICE_POINT_MS / 1000,
    ],
  );
  if (Math.random() < 0.02)
    await client.query(
      "DELETE FROM hoodball.price_points WHERE ts < now() - make_interval(days => $1)",
      [PRICE_RETENTION_DAYS],
    );
}
export async function priceHistory(
  client: PoolClient,
  hours: number,
  max: number,
): Promise<PricePoint[]> {
  const rows = (
    await client.query(
      "SELECT ts,price_usd,market_cap_usd FROM hoodball.price_points WHERE ts > now() - make_interval(hours => $1) ORDER BY ts ASC",
      [hours],
    )
  ).rows;
  return downsample(
    rows.map((row) => ({
      ts: new Date(row.ts).toISOString(),
      priceUsd: row.price_usd === null ? null : Number(row.price_usd),
      marketCapUsd:
        row.market_cap_usd === null ? null : Number(row.market_cap_usd),
    })),
    max,
  );
}
async function sparkline(client: PoolClient) {
  return (await priceHistory(client, 24, 60))
    .map((point) => point.priceUsd)
    .filter((value): value is number => value !== null);
}

async function fixtureMarket(client: PoolClient): Promise<MarketData> {
  const latest = (
    await client.query(
      "SELECT ts,price_usd,market_cap_usd FROM hoodball.price_points ORDER BY ts DESC LIMIT 1",
    )
  ).rows[0];
  if (!latest)
    return {
      ...emptyMarket("unknown"),
      error: "Market reads are disabled on this read-only instance",
    };
  return {
    ...emptyMarket("curve"),
    source: "curve",
    pairSymbol: "ETH",
    priceUsd: latest.price_usd === null ? null : Number(latest.price_usd),
    marketCapUsd:
      latest.market_cap_usd === null ? null : Number(latest.market_cap_usd),
    progress: FIXTURE_PROGRESS,
    raisedEth: FIXTURE_PROGRESS * FIXTURE_THRESHOLD_ETH,
    graduationThresholdEth: FIXTURE_THRESHOLD_ETH,
    launchSupply: "1000000000",
    sparkline: await sparkline(client),
    updatedAt: new Date(latest.ts).toISOString(),
  };
}

async function build(
  client: PoolClient,
  config: RuntimeConfig,
  totalSupply: string | null,
): Promise<MarketData> {
  const token = config.tokenAddress!;
  const launch = await describeLaunch(token);
  if (!launch.launched)
    return {
      ...emptyMarket("unknown"),
      sparkline: await sparkline(client),
      error: null,
    };
  const quoteSymbol =
    launch.quote?.symbol ?? (launch.isNativeQuote ? "ETH" : launch.pairToken);
  const quoteDecimals = launch.quote?.decimals ?? 18;
  const market =
    launch.phase === 0
      ? await readCurve(launch, quoteSymbol, quoteDecimals)
      : launch.phase === 3
        ? {
            ...emptyMarket("unknown"),
            curveAddress: launch.curve,
            pairSymbol: quoteSymbol,
            error: "Launch graduation was rescued by the Pons operator",
          }
        : await readPool(launch, quoteSymbol, totalSupply);
  await persistPoint(client, market);
  market.sparkline = await sparkline(client);
  market.updatedAt = new Date().toISOString();
  return market;
}

export async function getMarket(
  client: PoolClient,
  config: RuntimeConfig,
  totalSupply: string | null = null,
): Promise<MarketData> {
  if (!config.tokenAddress || config.tokenAddress === ZERO_ADDRESS)
    return emptyMarket("prelaunch");
  const key = `${config.tokenAddress.toLowerCase()}:${readOnlyMode() ? "ro" : "rw"}`;
  if (cache && cache.key === key && Date.now() - cache.at < intervalMs())
    return cache.data;
  if (!inflight) {
    inflight = (
      readOnlyMode()
        ? fixtureMarket(client)
        : build(client, config, totalSupply)
    )
      .then((data) => {
        cache = { key, at: Date.now(), data };
        return data;
      })
      .catch((error) => {
        console.error(
          "Market:",
          error instanceof Error ? error.message : "unknown",
        );
        const message = "Market data is temporarily unavailable";
        const data =
          cache && cache.key === key
            ? { ...cache.data, error: message }
            : { ...emptyMarket("unknown"), error: message };
        cache = { key, at: Date.now(), data };
        return data;
      })
      .finally(() => {
        inflight = null;
      });
  }
  return inflight;
}
export function resetMarketCache() {
  cache = null;
}
