"use client";

import { useLive } from "@/components/live/LiveProvider";
import AddressDisplay from "@/components/ui/Address";

export default function TopBar() {
  const { snapshot, explorer } = useLive();
  const twitterUrl = snapshot?.config.twitterUrl ?? null;
  const tokenAddress = snapshot?.config.tokenAddress ?? null;

  return (
    <div className="topbar">
      {twitterUrl ? (
        <a
          className="x-pill"
          href={twitterUrl}
          target="_blank"
          rel="noopener noreferrer"
          aria-label="Hoodball on X"
        >
          𝕏
        </a>
      ) : (
        <span className="x-pill muted" aria-label="X account coming soon">
          𝕏 soon
        </span>
      )}
      <AddressDisplay
        address={tokenAddress}
        prefix="CA:"
        placeholder="TBA"
        head={4}
        tail={4}
        href={tokenAddress ? `${explorer}/token/${tokenAddress}` : null}
      />
    </div>
  );
}
