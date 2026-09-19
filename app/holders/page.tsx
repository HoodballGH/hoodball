"use client";

import type { Holder } from "@/lib/types";
import { useLive } from "@/components/live/LiveProvider";
import Shell from "@/components/home/Shell";
import { usePaged } from "@/components/home/usePaged";
import { Card, Pill } from "@/components/ui/primitives";
import { num, pct, short, tokenAmount } from "@/components/ui/format";
import { exclusionSentence } from "@/components/home/copy";

const LIMIT = 100;

export default function HoldersPage() {
  const { snapshot } = useLive();
  const { items, total, offset, loading, error, setOffset } = usePaged<Holder>("/api/holders", LIMIT);
  const symbol = snapshot?.config.tokenSymbol ?? "HOODBALL";
  const page = Math.floor(offset / LIMIT) + 1;
  const pages = Math.max(1, Math.ceil(total / LIMIT));

  return (
    <Shell compact>
      <div className="column">
        <div className="row between wrap" style={{ marginBottom: "1.5rem" }}>
          <h1 className="heading">Holders</h1>
          <span className="t-sm muted">
            {num(total)} holders · {num(snapshot?.stats.eligibleHolders ?? 0)}{" "}
            eligible
          </span>
        </div>

        <Card round>
          {error ? (
            <p className="empty">Holders are temporarily unavailable.</p>
          ) : loading && items.length === 0 ? (
            <p className="empty">Loading…</p>
          ) : items.length === 0 ? (
            <p className="empty">No holders yet…</p>
          ) : (
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th className="num">#</th>
                    <th>Address</th>
                    <th className="num">
                      Balance <span className="hide-sm">({symbol})</span>
                    </th>
                    <th className="num hide-sm">Share</th>
                    <th>Draw</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((holder) => (
                    <tr key={holder.address}>
                      <td className="num muted">{num(holder.rank)}</td>
                      <td className="mono">
                        <a
                          className="link quiet"
                          href={holder.explorerUrl}
                          target="_blank"
                          rel="noreferrer"
                        >
                          {short(holder.address, 6, 4)}
                        </a>
                      </td>
                      <td className="num">
                        {tokenAmount(holder.balanceFormatted, 2)}
                      </td>
                      <td className="num hide-sm">{pct(holder.sharePct, 3)}</td>
                      <td>
                        {holder.eligible ? (
                          <Pill tone="lime">Eligible</Pill>
                        ) : (
                          <Pill tone="muted">
                            {exclusionSentence(holder.exclusionReason)}
                          </Pill>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        <div className="pager">
          <button
            type="button"
            className="btn"
            disabled={offset === 0 || loading}
            onClick={() => setOffset(Math.max(0, offset - LIMIT))}
          >
            ← Previous
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
            Next →
          </button>
        </div>
      </div>
    </Shell>
  );
}
