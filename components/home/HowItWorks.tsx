"use client";

import { useLive } from "@/components/live/LiveProvider";
import { Card } from "@/components/ui/primitives";

export default function HowItWorks() {
  const { snapshot } = useLive();
  const symbol = snapshot?.config.tokenSymbol ?? "HOODBALL";
  const minutes = Math.round((snapshot?.draws.intervalSeconds ?? 3600) / 60);

  return (
    <Card round className="section how">
      <p className="card-title" style={{ marginBottom: "0.75rem" }}>
        How it works
      </p>
      <ol>
        <li>
          Creator fees from the Pons launch are claimed into the vault, and that
          ETH is the pot.
        </li>
        <li>
          Every {minutes} minutes one holder is drawn at random, weighted by
          balance: hold 2× more, win 2× as often.
        </li>
        <li>
          Liquidity pools, contracts, the vault and burn addresses are never
          eligible. Just hold ${symbol} in your own wallet.
        </li>
        <li>
          Each draw publishes a seed hash up front and reveals the seed after
          payout, so every winner can be verified on-chain.
        </li>
        <li>

          Fully open source: read the engine and replay any draw at{" "}

          <a href="https://github.com/HoodballGH/hoodball" target="_blank" rel="noopener noreferrer">

            github.com/HoodballGH/hoodball

          </a>

          .

        </li>
      </ol>
    </Card>
  );
}
