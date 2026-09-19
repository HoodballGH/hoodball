"use client";

import { useState } from "react";
import type { DrawRecord } from "@/lib/types";
import Eth from "@/components/ui/Eth";
import { useLive } from "@/components/live/LiveProvider";
import { Card, RefreshIcon } from "@/components/ui/primitives";
import { dateTime, eth, short, usd } from "@/components/ui/format";

function PayoutRow({ draw }: { draw: DrawRecord }) {
  if (draw.payouts.length === 0) {
    return (
      <Card round hoverable>
        <div className="winner">
          <div className="left">
            <p className="addr muted">No winner, pot rolled over</p>
            <p className="when">
              {dateTime(draw.executedAt ?? draw.scheduledAt)}
            </p>
          </div>
          <div className="right">
            <p className="amount muted">{eth(draw.potEth)}<Eth /></p>
          </div>
        </div>
      </Card>
    );
  }
  return (
    <>
      {draw.payouts.map((payout) => (
        <Card round hoverable key={payout.id}>
          <div className="winner">
            <div className="left">
              <p className="addr">{short(payout.recipient, 6, 6)}</p>
              <p className="when">
                {dateTime(
                  payout.confirmedAt ?? draw.executedAt ?? draw.scheduledAt,
                )}
              </p>
            </div>
            <div className="right">
              <p className="amount">{eth(payout.amountEth)}<Eth /></p>
              {payout.amountUsd !== null ? (
                <p className="t-xs muted" style={{ margin: "0.1rem 0 0" }}>
                  {usd(payout.amountUsd)}
                </p>
              ) : null}
              {payout.explorerUrl && payout.status === "confirmed" ? (
                <a
                  className="link sm"
                  href={payout.explorerUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  View on Blockscout →
                </a>
              ) : (
                <span className="t-xs lime-text">
                  {payout.status === "confirmed" ? "Paid" : "Payout confirming…"}
                </span>
              )}
            </div>
          </div>
        </Card>
      ))}
    </>
  );
}

export default function RecentWinners() {
  const { snapshot, refresh } = useLive();
  const [refreshing, setRefreshing] = useState(false);
  const draws = (snapshot?.recentDraws ?? []).filter(
    (draw) => draw.status !== "skipped",
  );
  const vaultUrl = snapshot?.vault.explorerUrl ?? null;

  const handleRefresh = () => {
    setRefreshing(true);
    refresh();
    window.setTimeout(() => setRefreshing(false), 800);
  };

  return (
    <div className="section">
      <div
        className="row center"
        style={{ gap: "0.75rem", marginBottom: "1.5rem" }}
      >
        <h2 className="heading">Recent winners</h2>
        <button
          type="button"
          onClick={handleRefresh}
          disabled={refreshing}
          className="btn icon"
          title="Refresh winners"
          aria-label="Refresh winners"
        >
          <RefreshIcon spinning={refreshing} />
        </button>
        {vaultUrl ? (
          <a className="link" href={vaultUrl} target="_blank" rel="noreferrer">
            payouts
          </a>
        ) : null}
      </div>

      <div className="stack">
        {draws.length === 0 ? (
          <Card round>
            <p className="empty">No winners yet…</p>
          </Card>
        ) : (
          draws.map((draw) => <PayoutRow key={draw.id} draw={draw} />)
        )}
      </div>
    </div>
  );
}
