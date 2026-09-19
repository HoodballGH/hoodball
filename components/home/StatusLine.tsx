"use client";

import { useLive } from "@/components/live/LiveProvider";
import { num } from "@/components/ui/format";
import { CHAIN_STATUS_COPY } from "./copy";

export default function StatusLine() {
  const { snapshot, connected, error } = useLive();
  const chain = snapshot?.chain;
  const status = error
    ? "Offline"
    : (CHAIN_STATUS_COPY[chain?.status ?? ""] ?? "Connecting");
  const block = chain?.indexedBlock ?? chain?.headBlock ?? null;

  return (
    <div className="status-line">
      <span>
        {status}
        {connected ? " · streaming" : ""}
      </span>
      <span className="dim">·</span>
      <span>Block {block ? num(block) : "—"}</span>
      <span className="dim">·</span>
      <span>Robinhood Chain · Pons V2</span>
    </div>
  );
}
