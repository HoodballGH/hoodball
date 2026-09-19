"use client";

import Eth from "@/components/ui/Eth";

import type { DrawRecord } from "@/lib/types";
import Shell from "@/components/home/Shell";
import { usePaged } from "@/components/home/usePaged";
import { Card, Pill } from "@/components/ui/primitives";
import { CopyButton } from "@/components/ui/Address";
import {
  dateTime,
  eth,
  num,
  short,
  tokenAmount,
  usd,
} from "@/components/ui/format";
import { DRAW_STATUS_COPY } from "@/components/home/copy";

const LIMIT = 25;

function statusTone(status: string) {
  if (status === "paid") return "lime" as const;
  if (status === "rolled_over" || status === "scheduled")
    return "muted" as const;
  if (status === "review") return "bad" as const;
  return "warn" as const;
}

function SeedLine({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="kv">
      <span className="k">{label}</span>
      <span className="v seed">
        {value ? (
          <>
            {value} <CopyButton value={value} />
          </>
        ) : (
          "revealed after payout"
        )}
      </span>
    </div>
  );
}

function DrawCard({ draw }: { draw: DrawRecord }) {
  return (
    <Card round hoverable>
      <div className="row between wrap" style={{ marginBottom: "0.75rem" }}>
        <p className="card-title">Cycle #{num(draw.cycleId)}</p>
        <Pill tone={statusTone(draw.status)}>
          {DRAW_STATUS_COPY[draw.status] ?? draw.status}
        </Pill>
      </div>

      <div className="kv">
        <span className="k">Scheduled</span>
        <span className="v">{dateTime(draw.scheduledAt)}</span>
      </div>
      <div className="kv">
        <span className="k">Executed</span>
        <span className="v">{dateTime(draw.executedAt)}</span>
      </div>
      <div className="kv">
        <span className="k">Pot</span>
        <span className="v">
          {eth(draw.potEth)}<Eth />{" "}
          {draw.potUsd !== null ? (
            <span className="muted">({usd(draw.potUsd)})</span>
          ) : null}
        </span>
      </div>
      <div className="kv">
        <span className="k">Eligible holders</span>
        <span className="v">{num(draw.eligibleHolders)}</span>
      </div>
      {draw.snapshotBlock ? (
        <div className="kv">
          <span className="k">Snapshot block</span>
          <span className="v">{num(draw.snapshotBlock)}</span>
        </div>
      ) : null}
      {draw.skipReason ? (
        <div className="kv">
          <span className="k">Reason</span>
          <span className="v">{draw.skipReason.replace(/_/g, " ")}</span>
        </div>
      ) : null}

      <SeedLine label="Seed hash" value={draw.seedHash} />
      <SeedLine label="Seed" value={draw.seed} />

      {draw.payouts.length > 0 ? (
        <div style={{ marginTop: "0.75rem" }}>
          {draw.payouts.map((payout) => (
            <div
              className="winner"
              key={payout.id}
              style={{ marginTop: "0.5rem" }}
            >
              <div className="left">
                <p className="addr">{short(payout.recipient, 6, 6)}</p>
                <p className="when">
                  {payout.oddsPct.toFixed(2)}% odds ·{" "}
                  {tokenAmount(payout.balanceFormatted, 2)} held
                </p>
              </div>
              <div className="right">
                <p className="amount">{eth(payout.amountEth)}<Eth /></p>
                {payout.explorerUrl ? (
                  <a
                    className="link sm"
                    href={payout.explorerUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    View on Blockscout →
                  </a>
                ) : (
                  <span className="t-xs dim">{payout.status}</span>
                )}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <p className="t-sm muted" style={{ margin: "0.75rem 0 0" }}>
          No winner, pot rolled over.
        </p>
      )}
    </Card>
  );
}

export default function DrawsPage() {
  const { items, total, offset, loading, error, setOffset } =
    usePaged<DrawRecord>("/api/draws", LIMIT);
  const page = Math.floor(offset / LIMIT) + 1;
  const pages = Math.max(1, Math.ceil(total / LIMIT));

  return (
    <Shell compact>
      <div className="column">
        <div className="row between wrap" style={{ marginBottom: "1.5rem" }}>
          <h1 className="heading">Draw history</h1>
          <span className="t-sm muted">{num(total)} draws</span>
        </div>

        {error ? (
          <Card round>
            <p className="empty">Draw history is temporarily unavailable.</p>
          </Card>
        ) : loading && items.length === 0 ? (
          <Card round>
            <p className="empty">Loading…</p>
          </Card>
        ) : items.length === 0 ? (
          <Card round>
            <p className="empty">No draws yet…</p>
          </Card>
        ) : (
          <div className="stack">
            {items.map((draw) => (
              <DrawCard key={draw.id} draw={draw} />
            ))}
          </div>
        )}

        <div className="pager">
          <button
            type="button"
            className="btn"
            disabled={offset === 0 || loading}
            onClick={() => setOffset(Math.max(0, offset - LIMIT))}
          >
            ← Newer
          </button>
          <span className="t-sm muted">
            Page {page} of {pages}
          </span>
          <button
            type="button"
            className="btn"
            disabled={offset + LIMIT >= total || loading}
            onClick={() => setOffset(offset + LIMIT)}
          >
            Older →
          </button>
        </div>
      </div>
    </Shell>
  );
}
