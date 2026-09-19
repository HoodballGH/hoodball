import { ZERO_ADDRESS } from "./chain";
export type BalanceState = { balance: bigint; firstSeenAt: string | null };
export function applyTransfer(
  state: Map<string, BalanceState>,
  from: string,
  to: string,
  amount: bigint,
  timestamp: string,
) {
  if (amount < 0n) throw new Error("Negative transfer amount");
  if (amount === 0n || from === to) return;
  if (from !== ZERO_ADDRESS) {
    const sender = state.get(from) ?? { balance: 0n, firstSeenAt: null };
    if (sender.balance < amount)
      throw new Error(
        "Transfer exceeds indexed balance; full token history is required",
      );
    sender.balance -= amount;
    state.set(from, sender);
  }
  if (to !== ZERO_ADDRESS) {
    const receiver = state.get(to) ?? { balance: 0n, firstSeenAt: null };
    receiver.firstSeenAt ??= timestamp;
    receiver.balance += amount;
    state.set(to, receiver);
  }
}
