import type { Hex } from "viem";
import { rpc } from "./rpc";

// A legacy gasPrice is also the max fee. The base fee moves between signing and
// inclusion, so signing at exactly eth_gasPrice gets rejected with
// "max fee per gas less than block base fee". Sign with headroom instead.
export const GAS_PRICE_MULTIPLIER = 2n;

export async function suggestedGasPrice(maxGasPrice: bigint): Promise<bigint> {
  const [priceHex, block] = await Promise.all([
    rpc<Hex>("eth_gasPrice"),
    rpc<{ baseFeePerGas?: Hex } | null>("eth_getBlockByNumber", [
      "latest",
      false,
    ]),
  ]);
  const price = BigInt(priceHex);
  const baseFee = block?.baseFeePerGas ? BigInt(block.baseFeePerGas) : 0n;
  const floor = price > baseFee ? price : baseFee;
  const buffered = floor * GAS_PRICE_MULTIPLIER;
  if (floor > maxGasPrice) return floor;
  return buffered > maxGasPrice ? maxGasPrice : buffered;
}

export function isUnderpricedRejection(error: unknown) {
  return (
    error instanceof Error &&
    /base fee|underpriced|fee too low|max fee per gas|gas price below|intrinsic gas too low|gas limit too low/i.test(
      error.message,
    )
  );
}

// Robinhood Chain is an Arbitrum-style rollup: a plain transfer needs more than
// 21000 gas because the L1 data fee is charged as extra gas units.
export async function estimateTransferGas(from: string, to: string, value: bigint) {
  let estimate: bigint;
  try {
    estimate = BigInt(
      await rpc<Hex>("eth_estimateGas", [{ from, to, value: `0x${value.toString(16)}` }]),
    );
  } catch (error) {
    // "insufficient funds" and similar: let the caller's balance check decide
    // instead of failing the whole tick. Arbitrum-style transfers use well
    // under this; unused gas is refunded.
    console.error(`estimateGas fallback: ${error instanceof Error ? error.message : "unknown"}`);
    return 400_000n;
  }
  const padded = (estimate * 130n) / 100n;
  const floor = 21000n;
  const cap = 2_000_000n;
  if (padded < floor) return floor;
  return padded > cap ? cap : padded;
}
