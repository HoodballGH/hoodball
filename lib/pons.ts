import {
  decodeFunctionResult,
  encodeFunctionData,
  formatUnits,
  parseAbi,
  type Hex,
} from "viem";
import { ZERO_ADDRESS } from "./chain";
import { rpc } from "./rpc";

export const PONS_FACTORY = "0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e";
export const PONS_FEE_ESCROW = "0xd3AFEB2a57f70eF218Aa82451c51B2fb0416Ac9e";
export const PONS_MEME_HOOK = "0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044";
export const UNISWAP_V3_FACTORY = "0x1f7d7550B1b028f7571E69A784071F0205FD2EfA";
export const WETH = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";
export const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
export const CHAINLINK_ETH_USD = "0x78F3556b67E17Df817D51Ef5a990cDaF09E8d3A9";
export const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11";
export const FEE_TIERS = [100, 500, 3000, 10000] as const;

export const factoryAbi = parseAbi([
  "struct LaunchedToken { address token; address curve; address deployer; address creatorFeeRecipient; address pairToken; uint256 graduationThreshold; uint24 poolFee; int24 tickSpacing; uint16 creatorTaxBps; bool buybackEnabled; uint8 phase; uint256 sweptQuote; uint256 sweptTokens; uint256 sweptAt; bool exists; }",
  "function getLaunchedToken(address token) view returns (LaunchedToken)",
  "event TokenLaunched(address indexed token, address indexed curve, address indexed deployer, address pairToken, uint256 launchConfigId, uint256 graduationThreshold)",
]);
export const curveAbi = parseAbi([
  "function getReserves() view returns (uint256 quoteReserve_, uint256 tokenReserve_)",
  "function realQuoteReserve() view returns (uint256)",
  "function graduationThreshold() view returns (uint256)",
  "function phantomQuote() view returns (uint256)",
  "function graduated() view returns (bool)",
  "function launchSupply() view returns (uint256)",
  "function quoteFeeBalance() view returns (uint256)",
  "function creatorTaxBalance() view returns (uint256)",
  "function buybackQuoteBalance() view returns (uint256)",
  "function protocolFeeShareBps() view returns (uint16)",
  "function buybackEnabled() view returns (bool)",
  "function deployer() view returns (address)",
  "function isNativeQuote() view returns (bool)",
  "function sweepFees(uint256 minBuybackTokensOut)",
  "event FeesSwept(uint256 protocolAmount, uint256 buybackAmount, uint256 creatorAmount)",
]);
export const escrowAbi = parseAbi([
  "function balanceOf(address recipient) view returns (uint256)",
  "function balanceOfToken(address recipient, address token) view returns (uint256)",
  "function claim() returns (uint256 amount)",
  "function claimToken(address token) returns (uint256 amount)",
  "event Claimed(address indexed recipient, uint256 amount)",
  "event ClaimedToken(address indexed recipient, address indexed token, uint256 amount)",
]);
export const wethAbi = parseAbi([
  "function balanceOf(address account) view returns (uint256)",
  "function withdraw(uint256 wad)",
  "event Withdrawal(address indexed src, uint256 wad)",
]);
export const multicall3Abi = parseAbi([
  "struct Call3 { address target; bool allowFailure; bytes callData; }",
  "struct Result { bool success; bytes returnData; }",
  "function aggregate3(Call3[] calls) payable returns (Result[] returnData)",
  "function getEthBalance(address addr) view returns (uint256 balance)",
]);
export const uniswapFactoryAbi = parseAbi([
  "function getPool(address tokenA, address tokenB, uint24 fee) view returns (address pool)",
]);
export const aggregatorAbi = parseAbi([
  "function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)",
]);

export type QuoteAsset = {
  symbol: string;
  name: string;
  address: string;
  decimals: number;
  assetClass: string;
  feed: string | null;
};
export const QUOTE_ASSETS: QuoteAsset[] = [
  { symbol: "ETH", name: "Ether", address: ZERO_ADDRESS, decimals: 18, assetClass: "native", feed: CHAINLINK_ETH_USD },
  { symbol: "WETH", name: "Wrapped Ether", address: WETH, decimals: 18, assetClass: "native", feed: CHAINLINK_ETH_USD },
  { symbol: "USDG", name: "Global Dollar", address: USDG, decimals: 6, assetClass: "stablecoin", feed: null },
];
export function quoteAssetFor(address: string): QuoteAsset | null {
  const target = (address || ZERO_ADDRESS).toLowerCase();
  return (
    QUOTE_ASSETS.find((asset) => asset.address.toLowerCase() === target) ?? null
  );
}
export function quoteAssetBySymbol(symbol: string): QuoteAsset | null {
  return (
    QUOTE_ASSETS.find(
      (asset) => asset.symbol.toLowerCase() === symbol.toLowerCase(),
    ) ?? null
  );
}

export type Call = { target: string; data: Hex; allowFailure?: boolean };
export type CallResult = { success: boolean; data: Hex };
export async function multicall(
  calls: Call[],
  tag = "latest",
): Promise<CallResult[]> {
  if (!calls.length) return [];
  const data = encodeFunctionData({
    abi: multicall3Abi,
    functionName: "aggregate3",
    args: [
      calls.map((call) => ({
        target: call.target as Hex,
        allowFailure: call.allowFailure ?? true,
        callData: call.data,
      })),
    ],
  });
  const raw = await rpc<Hex>("eth_call", [{ to: MULTICALL3, data }, tag]);
  const results = decodeFunctionResult({
    abi: multicall3Abi,
    functionName: "aggregate3",
    data: raw,
  });
  if (results.length !== calls.length)
    throw new Error("Multicall result count mismatch");
  return results.map((result) => ({
    success: result.success,
    data: result.returnData,
  }));
}

export const PHASE_NAMES = ["curve", "graduating", "pool", "rescued"] as const;
export type LaunchInfo = {
  launched: boolean;
  token: string;
  curve: string | null;
  phase: number;
  phaseName: "curve" | "graduating" | "pool" | "rescued" | "unknown";
  graduated: boolean;
  pairToken: string;
  isNativeQuote: boolean;
  quote: QuoteAsset | null;
  creatorFeeRecipient: string | null;
  buybackEnabled: boolean;
  creatorTaxBps: number | null;
  graduationThreshold: bigint | null;
};
const launchCache = new Map<string, { at: number; value: LaunchInfo }>();
export function notLaunched(token: string): LaunchInfo {
  return {
    launched: false,
    token: token.toLowerCase(),
    curve: null,
    phase: -1,
    phaseName: "unknown",
    graduated: false,
    pairToken: ZERO_ADDRESS,
    isNativeQuote: true,
    quote: quoteAssetFor(ZERO_ADDRESS),
    creatorFeeRecipient: null,
    buybackEnabled: false,
    creatorTaxBps: null,
    graduationThreshold: null,
  };
}
export async function describeLaunch(
  token: string,
  maxAgeMs = 60000,
): Promise<LaunchInfo> {
  const key = token.toLowerCase();
  const hit = launchCache.get(key);
  if (hit && Date.now() - hit.at < maxAgeMs) return hit.value;
  const raw = await rpc<Hex>("eth_call", [
    {
      to: PONS_FACTORY,
      data: encodeFunctionData({
        abi: factoryAbi,
        functionName: "getLaunchedToken",
        args: [token as Hex],
      }),
    },
    "latest",
  ]);
  const record = decodeFunctionResult({
    abi: factoryAbi,
    functionName: "getLaunchedToken",
    data: raw,
  });
  let value: LaunchInfo;
  if (!record.exists || record.token.toLowerCase() !== key)
    value = notLaunched(token);
  else {
    const pairToken = record.pairToken.toLowerCase();
    const phase = Number(record.phase);
    value = {
      launched: true,
      token: key,
      curve: record.curve.toLowerCase(),
      phase,
      phaseName: PHASE_NAMES[phase] ?? "unknown",
      graduated: phase >= 1,
      pairToken,
      isNativeQuote: pairToken === ZERO_ADDRESS,
      quote: quoteAssetFor(pairToken),
      creatorFeeRecipient: record.creatorFeeRecipient.toLowerCase(),
      buybackEnabled: record.buybackEnabled,
      creatorTaxBps: Number(record.creatorTaxBps),
      graduationThreshold: record.graduationThreshold,
    };
  }
  launchCache.set(key, { at: Date.now(), value });
  return value;
}
export function forgetLaunch(token?: string) {
  if (token) launchCache.delete(token.toLowerCase());
  else launchCache.clear();
}

export type CurveReserves = {
  quoteReserve: bigint;
  tokenReserve: bigint;
  realQuoteReserve: bigint;
  graduationThreshold: bigint;
  launchSupply: bigint;
  quoteDecimals: number;
};
export function curveMetrics(input: CurveReserves) {
  const quote = Number(formatUnits(input.quoteReserve, input.quoteDecimals));
  const tokens = Number(formatUnits(input.tokenReserve, 18));
  const supply = Number(formatUnits(input.launchSupply, 18));
  const raised = Number(
    formatUnits(input.realQuoteReserve, input.quoteDecimals),
  );
  const threshold = Number(
    formatUnits(input.graduationThreshold, input.quoteDecimals),
  );
  const priceQuote = tokens > 0 && quote > 0 ? quote / tokens : null;
  const marketCapQuote =
    input.tokenReserve > 0n
      ? Number(
          formatUnits(
            (input.quoteReserve * input.launchSupply) / input.tokenReserve,
            input.quoteDecimals,
          ),
        )
      : null;
  const progress =
    threshold > 0 ? Math.min(1, Math.max(0, raised / threshold)) : null;
  return {
    priceQuote,
    marketCapQuote,
    raisedQuote: raised,
    thresholdQuote: threshold,
    progress,
    supply,
  };
}

export function sweepClaimable(
  quoteFeeBalance: bigint,
  creatorTaxBalance: bigint,
  protocolFeeShareBps: bigint | number,
) {
  const share = BigInt(protocolFeeShareBps);
  if (share < 0n || share > 10000n)
    throw new Error("Invalid protocol fee share");
  return (
    quoteFeeBalance - (quoteFeeBalance * share) / 10000n + creatorTaxBalance
  );
}

export function curveCall(
  curve: string,
  functionName:
    | "getReserves"
    | "realQuoteReserve"
    | "graduationThreshold"
    | "launchSupply"
    | "quoteFeeBalance"
    | "creatorTaxBalance"
    | "buybackQuoteBalance"
    | "protocolFeeShareBps"
    | "buybackEnabled"
    | "graduated"
    | "deployer"
    | "phantomQuote"
    | "isNativeQuote",
): Call {
  return {
    target: curve,
    data: encodeFunctionData({ abi: curveAbi, functionName }),
  };
}
