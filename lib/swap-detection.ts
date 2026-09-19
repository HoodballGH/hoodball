import { decodeEventLog, encodeEventTopics, parseAbiItem, type Hex } from "viem";
const v2 = parseAbiItem("event Swap(address indexed sender, uint256 amount0In, uint256 amount1In, uint256 amount0Out, uint256 amount1Out, address indexed to)");
const v3 = parseAbiItem("event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)");
const v2Topic = encodeEventTopics({ abi: [v2], eventName: "Swap" })[0];
const v3Topic = encodeEventTopics({ abi: [v3], eventName: "Swap" })[0];
export type ReceiptLog = { address: string; data: Hex; topics: Hex[] };
export function swapPoolCandidates(logs: ReceiptLog[]) {
  const candidates = new Set<string>();
  for (const log of logs) {
    if (!/^0x[\da-f]{40}$/i.test(log.address) || ![v2Topic, v3Topic].includes(log.topics[0])) continue;
    try {
      if (log.topics[0] === v2Topic) {
        const { args } = decodeEventLog({ abi: [v2], data: log.data, topics: log.topics as [Hex, ...Hex[]] });
        if (args.amount0In + args.amount1In === 0n || args.amount0Out + args.amount1Out === 0n) continue;
      } else {
        const { args } = decodeEventLog({ abi: [v3], data: log.data, topics: log.topics as [Hex, ...Hex[]] });
        if (args.amount0 === 0n || args.amount1 === 0n || (args.amount0 > 0n) === (args.amount1 > 0n)) continue;
      }
      candidates.add(log.address.toLowerCase());
    } catch { continue; }
  }
  return [...candidates];
}
export function decodePoolToken(value: string): string | null {
  if (!/^0x0{24}[a-f0-9]{40}$/i.test(value)) return null;
  return `0x${value.slice(-40)}`.toLowerCase();
}
export function poolContainsToken(token: string, token0Result: string, token1Result: string) {
  const a = decodePoolToken(token0Result); const b = decodePoolToken(token1Result);
  return a !== null && b !== null && a !== b && [a, b].includes(token.toLowerCase());
}
