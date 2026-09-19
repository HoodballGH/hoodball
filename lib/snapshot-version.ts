import { createHash } from "node:crypto";
export type VersionHolder = {
  address: string;
  balance: string;
  isContract: boolean;
  isPool: boolean;
};
export type VersionInput = {
  config: unknown;
  indexer: {
    phase: string;
    error: string | null;
    halted: boolean;
    totalSupply: string | null;
    status: string;
  };
  holders: Iterable<VersionHolder>;
  transferIds: string[];
  draws: { id: string; status: string; revealed: boolean }[];
  payouts: { id: string; status: string; txHash: string | null }[];
  drawsMeta: {
    gate: string;
    enabled: boolean;
    intervalSeconds: number;
    lastDrawAt: string | null;
    totalDraws: number;
    totalPaidWei: string;
    pending: Record<string, number>;
  };
  jackpot: { potWei: string; vaultEthWei: string | null };
  market?: unknown;
  treasury?: unknown;
};
export function shortHash(text: string) {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}
export function snapshotVersion(input: VersionInput) {
  const hash = createHash("sha256");
  const section = (name: string, value: unknown) => {
    hash.update(`${name}=${JSON.stringify(value)}\n`);
  };
  section("config", input.config);
  section("indexer", input.indexer);
  hash.update("holders\n");
  for (const holder of input.holders)
    hash.update(
      `${holder.address}|${holder.balance}|${holder.isContract ? 1 : 0}|${holder.isPool ? 1 : 0}\n`,
    );
  section("transfers", input.transferIds);
  section(
    "draws",
    input.draws.map((draw) => [draw.id, draw.status, draw.revealed ? 1 : 0]),
  );
  section(
    "payouts",
    input.payouts.map((payout) => [payout.id, payout.status, payout.txHash]),
  );
  section("drawsMeta", input.drawsMeta);
  section("jackpot", input.jackpot);
  if (input.market !== undefined) section("market", input.market);
  if (input.treasury !== undefined) section("treasury", input.treasury);
  return hash.digest("hex").slice(0, 16);
}
