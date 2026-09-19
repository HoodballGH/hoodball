import { decodeFunctionResult, encodeFunctionData } from "viem";
import { externalFetch } from "./rpc";
import { aggregatorAbi, CHAINLINK_ETH_USD, multicall } from "./pons";

const ETH_MAX_AGE_MS = () =>
  Math.max(
    60,
    Number(process.env.HOODBALL_ETH_PRICE_MAX_AGE_SECONDS ?? 3600) || 3600,
  ) * 1000;
const LAST_KNOWN_MS = 600_000;
const REFRESH_MS = 30_000;
type Quote = { usd: number; updatedAt: number; readAt: number };
let ethQuote: Quote | null = null;
let inflight: Promise<void> | null = null;
let lastAttempt = 0;

export function readOnlyMode() {
  return process.env.HOODBALL_WORKER_ENABLED === "false";
}

async function refresh() {
  lastAttempt = Date.now();
  const [result] = await multicall([
    {
      target: CHAINLINK_ETH_USD,
      data: encodeFunctionData({
        abi: aggregatorAbi,
        functionName: "latestRoundData",
      }),
    },
  ]);
  const now = Date.now();
  if (result?.success && result.data !== "0x") {
    try {
      const [roundId, answer, , updatedAt, answeredInRound] =
        decodeFunctionResult({
          abi: aggregatorAbi,
          functionName: "latestRoundData",
          data: result.data,
        });
      const updatedMs = Number(updatedAt) * 1000;
      const usd = Number(answer) / 1e8;
      if (
        usd > 0 &&
        Number.isFinite(usd) &&
        updatedMs > 0 &&
        updatedMs <= now + 60000 &&
        answeredInRound >= roundId &&
        now - updatedMs <= ETH_MAX_AGE_MS()
      )
        ethQuote = { usd, updatedAt: updatedMs, readAt: now };
    } catch {
      /* the spot fallback below covers a malformed feed answer */
    }
  }
  if (!ethQuote || now - ethQuote.updatedAt > ETH_MAX_AGE_MS())
    await refreshEthSpot(now);
}

async function refreshEthSpot(now: number) {
  try {
    const response = await externalFetch(
      "https://api.coinbase.com/v2/prices/ETH-USD/spot",
      { timeoutMs: 8000 },
    );
    if (!response.ok) return;
    const body = (await response.json()) as { data?: { amount?: string } };
    const usd = Number(body.data?.amount);
    if (usd > 0 && Number.isFinite(usd))
      ethQuote = { usd, updatedAt: now, readAt: now };
  } catch {
    /* Chainlink remains the primary source; the spot fallback is best effort. */
  }
}

function currentEthUsd() {
  if (!ethQuote) return null;
  const now = Date.now();
  if (
    now - ethQuote.updatedAt > ETH_MAX_AGE_MS() &&
    now - ethQuote.readAt > LAST_KNOWN_MS
  )
    return null;
  return ethQuote.usd;
}

export async function getPrices(): Promise<{ ethUsd: number | null }> {
  if (readOnlyMode()) return { ethUsd: null };
  if (Date.now() - lastAttempt >= REFRESH_MS) {
    if (!inflight)
      inflight = refresh()
        .catch((error) => {
          console.error(
            "Prices:",
            error instanceof Error ? error.message : "unknown",
          );
        })
        .finally(() => {
          inflight = null;
        });
    await inflight;
  }
  return { ethUsd: currentEthUsd() };
}

export async function ethUsd(): Promise<number | null> {
  return (await getPrices()).ethUsd;
}

export function ethUsdCached() {
  return readOnlyMode() ? null : currentEthUsd();
}

export async function quoteUsd(symbol: string): Promise<number | null> {
  const upper = symbol.toUpperCase();
  if (upper === "ETH" || upper === "WETH") return ethUsd();
  if (upper === "USDG") return 1;
  return null;
}

export function resetPricesForTests() {
  ethQuote = null;
  lastAttempt = 0;
}

export function usdValue(
  amountFormatted: string | null,
  priceUsd: number | null,
) {
  if (amountFormatted === null || priceUsd === null) return null;
  const amount = Number(amountFormatted);
  return Number.isFinite(amount) ? amount * priceUsd : null;
}
