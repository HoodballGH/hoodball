"use client";

import { useEffect, useRef } from "react";
import { useLive } from "@/components/live/LiveProvider";
import { Card, Pill } from "@/components/ui/primitives";
import { clockFromSeconds } from "@/components/ui/format";

export default function CountdownTimer() {
  const { snapshot, now, serverOffset, refresh } = useLive();
  const armed = useRef(false);
  const nextDrawAt = snapshot?.draws.nextDrawAt ?? null;
  const target = nextDrawAt ? new Date(nextDrawAt).getTime() : null;
  const secondsLeft =
    target === null
      ? null
      : Math.max(0, Math.ceil((target - (now + serverOffset)) / 1000));

  useEffect(() => {
    armed.current = false;
  }, [nextDrawAt]);

  useEffect(() => {
    if (secondsLeft === null || secondsLeft > 0 || armed.current) return;
    armed.current = true;
    const timer = window.setTimeout(refresh, 2000);
    return () => window.clearTimeout(timer);
  }, [secondsLeft, refresh]);

  return (
    <Card round className="countdown pad-lg">
      <div className="countdown-head">
        <p>Next draw in</p>
        {snapshot ? null : <Pill tone="warn">Syncing…</Pill>}
      </div>
      <div className="countdown-box">
        <h2 suppressHydrationWarning>
          {secondsLeft === null ? "—:—:—" : clockFromSeconds(secondsLeft)}
        </h2>
      </div>
      <p className="countdown-note">
        Payout lands within about a minute after the draw.
      </p>
    </Card>
  );
}
