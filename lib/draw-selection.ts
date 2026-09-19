import { concatHex, keccak256, toHex, type Hex } from "viem";

export type Weighted = { address: string; balance: bigint };

function normalizeSeed(seed: string): Hex {
  const text = seed.startsWith("0x") ? seed.slice(2) : seed;
  if (!/^[0-9a-f]{64}$/i.test(text))
    throw new Error("Draw seed must be 32 bytes of hex");
  return `0x${text.toLowerCase()}`;
}

/**
 * Unbiased BigInt draw in [0, total) from a keccak256(seed ‖ counter) stream.
 * Rejection sampling on the top `bitLength(total)` bits keeps the distribution
 * exact — no modulo bias, no floating point anywhere in the selection path.
 */
function nextBelow(seed: Hex, counter: { value: number }, total: bigint) {
  if (total <= 0n) throw new Error("Draw range must be positive");
  const bits = BigInt(total.toString(2).length);
  const shift = 256n - bits;
  for (let guard = 0; guard < 10000; guard++) {
    const digest = keccak256(
      concatHex([seed, toHex(BigInt(counter.value++), { size: 32 })]),
    );
    const value = BigInt(digest) >> shift;
    if (value < total) return value;
  }
  throw new Error("Draw randomness did not converge");
}

/**
 * Weighted sampling without replacement: weight = balance, so twice the balance
 * wins twice as often. Deterministic for a given seed and holder set.
 */
export function selectWinners<T extends Weighted>(
  seed: string,
  holders: T[],
  count: number,
): T[] {
  if (count <= 0) return [];
  const normalized = normalizeSeed(seed);
  const pool = holders
    .filter((holder) => holder.balance > 0n)
    .sort((a, b) =>
      a.address < b.address ? -1 : a.address > b.address ? 1 : 0,
    );
  if (pool.length <= count) return pool;
  const counter = { value: 0 };
  const winners: T[] = [];
  let total = pool.reduce((sum, holder) => sum + holder.balance, 0n);
  for (let round = 0; round < count; round++) {
    const target = nextBelow(normalized, counter, total);
    let cumulative = 0n;
    let index = pool.length - 1;
    for (let i = 0; i < pool.length; i++) {
      cumulative += pool[i].balance;
      if (target < cumulative) {
        index = i;
        break;
      }
    }
    const [winner] = pool.splice(index, 1);
    total -= winner.balance;
    winners.push(winner);
    if (!pool.length || total <= 0n) break;
  }
  return winners;
}

/** Equal split of the pot with the rounding remainder going to the first winner. */
export function splitPot(potWei: bigint, winners: number): bigint[] {
  if (winners <= 0 || potWei <= 0n) return [];
  const base = potWei / BigInt(winners);
  if (base <= 0n) return [];
  const amounts = Array.from({ length: winners }, () => base);
  amounts[0] += potWei - base * BigInt(winners);
  return amounts;
}
