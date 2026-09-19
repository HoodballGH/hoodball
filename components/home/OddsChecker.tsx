"use client";

import { useState, type FormEvent } from "react";
import type { OddsResult } from "@/lib/types";
import { useLive } from "@/components/live/LiveProvider";
import { Card, LimeButton } from "@/components/ui/primitives";
import { isAddressLike, num, pct, tokenAmount } from "@/components/ui/format";
import { exclusionSentence } from "./copy";

export default function OddsChecker() {
  const { snapshot } = useLive();
  const [value, setValue] = useState("");
  const [result, setResult] = useState<OddsResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const symbol = snapshot?.config.tokenSymbol ?? "HOODBALL";

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const address = value.trim();
    setResult(null);
    if (!isAddressLike(address)) {
      setError("That does not look like a 0x address.");
      return;
    }
    setError(null);
    setLoading(true);
    try {
      const res = await fetch(`/api/odds?address=${address.toLowerCase()}`, {
        cache: "no-store",
      });
      if (!res.ok) throw new Error("lookup failed");
      setResult((await res.json()) as OddsResult);
    } catch {
      setError("Could not look that address up. Try again in a moment.");
    }
    setLoading(false);
  };

  return (
    <Card round className="section">
      <p className="card-title" style={{ marginBottom: "0.75rem" }}>
        Check your odds
      </p>
      <form onSubmit={submit} className="field">
        <input
          value={value}
          onChange={(event) => setValue(event.target.value)}
          placeholder="0x your wallet address"
          aria-label="Wallet address"
          autoComplete="off"
          spellCheck={false}
        />
        <LimeButton type="submit" disabled={loading}>
          {loading ? "Checking…" : "Check"}
        </LimeButton>
      </form>

      {error ? (
        <p className="t-sm muted" style={{ marginBottom: 0 }}>
          {error}
        </p>
      ) : null}

      {result ? (
        <div className="stack tight" style={{ marginTop: "1rem" }}>
          <div className="kv">
            <span className="k">Balance</span>
            <span className="v">
              {tokenAmount(result.balanceFormatted)} {symbol}
            </span>
          </div>
          {result.eligible ? (
            <>
              <div className="kv">
                <span className="k">Share of the eligible supply</span>
                <span className="v">{pct(result.odds * 100, 4)}</span>
              </div>
              <div className="kv">
                <span className="k">Chance per draw</span>
                <span className="v lime">
                  {result.oneIn ? `1 in ${num(result.oneIn, 1)}` : "—"}
                </span>
              </div>
              <p className="t-xs dim" style={{ margin: 0 }}>
                Against {num(result.eligibleHolders)} eligible holders.
              </p>
            </>
          ) : (
            <p className="t-sm muted" style={{ margin: 0 }}>
              Not in the draw: {exclusionSentence(result.exclusionReason)}.
            </p>
          )}
        </div>
      ) : null}
    </Card>
  );
}
