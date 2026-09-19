import test from "node:test";
import assert from "node:assert/strict";
import { parseEther } from "viem";
import { curveMetrics, quoteAssetFor, sweepClaimable } from "../lib/pons";
import { downsample, pickDexPair } from "../lib/market";

const SUPPLY = parseEther("1000000000");
const PHANTOM = parseEther("1.68");
const THRESHOLD = parseEther("4.2");
const close = (actual: number | null, expected: number, tolerance = 1e-6) => {
  assert.notEqual(actual, null);
  assert.ok(
    Math.abs(actual! - expected) <= tolerance * Math.max(1, Math.abs(expected)),
    `${actual} vs ${expected}`,
  );
};

test("opening curve state: FDV equals phantomQuote (1.68 ETH) and progress is zero", () => {
  const metrics = curveMetrics({
    quoteReserve: PHANTOM,
    tokenReserve: SUPPLY,
    realQuoteReserve: 0n,
    graduationThreshold: THRESHOLD,
    launchSupply: SUPPLY,
    quoteDecimals: 18,
  });
  close(metrics.priceQuote, 1.68e-9);
  close(metrics.marketCapQuote, 1.68);
  assert.equal(metrics.progress, 0);
  assert.equal(metrics.raisedQuote, 0);
  assert.equal(metrics.thresholdQuote, 4.2);
});

test("graduation state: FDV equals (phantom + threshold)^2 / phantom (20.58 ETH) and progress is 1", () => {
  const quoteReserve = PHANTOM + THRESHOLD;
  const tokenReserve = (PHANTOM * SUPPLY) / quoteReserve;
  const metrics = curveMetrics({
    quoteReserve,
    tokenReserve,
    realQuoteReserve: THRESHOLD,
    graduationThreshold: THRESHOLD,
    launchSupply: SUPPLY,
    quoteDecimals: 18,
  });
  close(metrics.marketCapQuote, 20.58, 1e-9);
  close(metrics.priceQuote, 20.58e-9, 1e-9);
  assert.equal(metrics.progress, 1);
  close(Number(tokenReserve) / 1e18, 285714285.714, 1e-9);
});

test("mid-curve state: verified 1 ETH buy landmark (368,421,052.63 tokens out at 1% fee + 1% creator tax)", () => {
  const net = parseEther("0.98");
  const tokensOut = (net * SUPPLY) / (PHANTOM + net);
  close(Number(tokensOut) / 1e18, 368421052.63, 1e-9);
  const metrics = curveMetrics({
    quoteReserve: PHANTOM + net,
    tokenReserve: SUPPLY - tokensOut,
    realQuoteReserve: net,
    graduationThreshold: THRESHOLD,
    launchSupply: SUPPLY,
    quoteDecimals: 18,
  });
  close(metrics.progress, 0.98 / 4.2);
  close(metrics.marketCapQuote, (2.66 * 2.66) / 1.68, 1e-9);
});

test("ERC-20 quote decimals are respected (USDG 6 decimals)", () => {
  const phantom = 3236_000000n;
  const metrics = curveMetrics({
    quoteReserve: phantom,
    tokenReserve: SUPPLY,
    realQuoteReserve: 0n,
    graduationThreshold: 8090_000000n,
    launchSupply: SUPPLY,
    quoteDecimals: 6,
  });
  close(metrics.marketCapQuote, 3236);
  assert.equal(
    quoteAssetFor("0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168")?.symbol,
    "USDG",
  );
  assert.equal(
    quoteAssetFor("0x0000000000000000000000000000000000000000")?.symbol,
    "ETH",
  );
});

test("sweep claimable = quoteFee × (1 − protocol share) + creator tax", () => {
  assert.equal(
    sweepClaimable(parseEther("1"), parseEther("0.5"), 3000),
    parseEther("1.2"),
  );
  assert.equal(sweepClaimable(0n, 0n, 3000), 0n);
  assert.throws(() => sweepClaimable(1n, 0n, 10001));
});

test("downsample keeps endpoints and caps length", () => {
  const points = Array.from({ length: 1401 }, (_, i) => i);
  const sampled = downsample(points, 60);
  assert.equal(sampled.length, 60);
  assert.equal(sampled[0], 0);
  assert.equal(sampled[59], 1400);
  assert.deepEqual(downsample([1, 2, 3], 5), [1, 2, 3]);
});

test("dexscreener pair selection prefers the deepest robinhood pair for the token", () => {
  const token = "0xabc0000000000000000000000000000000000001";
  const picked = pickDexPair(
    [
      {
        chainId: "base",
        baseToken: { address: token },
        priceUsd: "9",
        liquidity: { usd: 1e9 },
      },
      {
        chainId: "robinhood",
        baseToken: { address: token },
        priceUsd: "1.5",
        liquidity: { usd: 100 },
        quoteToken: { symbol: "USDG" },
      },
      {
        chainId: "robinhood",
        baseToken: { address: token.toUpperCase().replace("0X", "0x") },
        priceUsd: "1.7",
        liquidity: { usd: 5000 },
        volume: { h24: 42 },
        priceChange: { h24: -3.2 },
        fdv: 1700,
      },
      {
        chainId: "robinhood",
        baseToken: { address: "0xother" },
        priceUsd: "99",
        liquidity: { usd: 1e7 },
      },
    ],
    token,
  );
  assert.equal(picked?.priceUsd, 1.7);
  assert.equal(picked?.liquidityUsd, 5000);
  assert.equal(picked?.marketCapUsd, 1700);
  assert.equal(picked?.priceChange24hPct, -3.2);
  assert.equal(pickDexPair([], token), null);
});
