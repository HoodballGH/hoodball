"use client";

import { useLive } from "@/components/live/LiveProvider";
import { Card, Pill, Stat } from "@/components/ui/primitives";
import { eth, num, usd } from "@/components/ui/format";
import { gateSentence } from "./copy";

export default function JackpotCard() {
  const { snapshot } = useLive();
  if (!snapshot) return null;
  const { jackpot, draws, stats, vault, treasury } = snapshot;
  const vaultLink = vault.explorerUrl;

  return (
    <Card round hoverable className="section">
      <div className="row between wrap" style={{ marginBottom: "0.75rem" }}>
        <p className="card-title">Current pot</p>
        {draws.gate === "ok" ? (
          <Pill tone="lime">Draws live</Pill>
        ) : (
          <Pill tone="warn">{gateSentence(draws.gate)}</Pill>
        )}
      </div>

      <p className="jackpot-amount lime" style={{ margin: 0 }}>
        {eth(jackpot.potEth)} ETH
      </p>
      <p className="t-sm muted" style={{ margin: "0.25rem 0 1.25rem" }}>
        {jackpot.potUsd !== null ? `${usd(jackpot.potUsd)} · ` : ""}paid to one
        holder, picked at random and weighted by balance
      </p>

      <div className="grid-3">
        <Stat label="Eligible holders" value={num(stats.eligibleHolders)} />
        <Stat
          label="Total paid out"
          value={`${eth(draws.totalPaidEth)} ETH`}
          sub={draws.totalPaidUsd !== null ? usd(draws.totalPaidUsd) : undefined}
        />
        <Stat
          label="Fees claimed to date"
          value={`${eth(treasury.totals.claimedEth)} ETH`}
          sub={`${num(draws.totalDraws)} draws so far`}
        />
      </div>

      <div className="row wrap" style={{ marginTop: "1rem", gap: "0.75rem" }}>
        {vaultLink ? (
          <a
            className="link sm"
            href={vaultLink}
            target="_blank"
            rel="noreferrer"
          >
            Vault on Blockscout →
          </a>
        ) : (
          <span className="t-xs dim">Vault not configured yet</span>
        )}
        <span className="t-xs dim">
          Gas reserve {eth(treasury.gasReserveEth)} ETH stays in the vault
        </span>
      </div>
    </Card>
  );
}
