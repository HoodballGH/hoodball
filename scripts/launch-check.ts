import { loadEnvConfig } from "@next/env";
loadEnvConfig(process.cwd());

const json = (value: unknown) =>
  JSON.stringify(
    value,
    (_, inner) => (typeof inner === "bigint" ? inner.toString() : inner),
    2,
  );

async function main() {
  const token = process.argv[2];
  if (!token) throw new Error("Usage: npx tsx scripts/launch-check.ts 0xToken");
  const { decodeFunctionResult } = await import("viem");
  const { assertChain } = await import("../lib/rpc");
  const { curveAbi, curveCall, curveMetrics, describeLaunch, multicall } =
    await import("../lib/pons");
  await assertChain();
  const launch = await describeLaunch(token, 0);
  console.log(json(launch));
  if (!launch.launched) {
    console.log("Token is not a Pons launch.");
    return;
  }
  if (!launch.isNativeQuote)
    console.log(
      `Launch is quoted in ${launch.quote?.symbol ?? launch.pairToken}; Hoodball pays native ETH only and would report gate "unsupported_quote".`,
    );
  if (launch.graduated || !launch.curve) return;
  const names = [
    "getReserves",
    "realQuoteReserve",
    "graduationThreshold",
    "launchSupply",
  ] as const;
  const results = await multicall(
    names.map((name) => curveCall(launch.curve!, name)),
  );
  if (results.some((result) => !result.success))
    throw new Error("Curve state read failed");
  const [quoteReserve, tokenReserve] = decodeFunctionResult({
    abi: curveAbi,
    functionName: "getReserves",
    data: results[0].data,
  });
  console.log(
    json(
      curveMetrics({
        quoteReserve,
        tokenReserve,
        realQuoteReserve: decodeFunctionResult({
          abi: curveAbi,
          functionName: "realQuoteReserve",
          data: results[1].data,
        }),
        graduationThreshold: decodeFunctionResult({
          abi: curveAbi,
          functionName: "graduationThreshold",
          data: results[2].data,
        }),
        launchSupply: decodeFunctionResult({
          abi: curveAbi,
          functionName: "launchSupply",
          data: results[3].data,
        }),
        quoteDecimals: launch.quote?.decimals ?? 18,
      }),
    ),
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
