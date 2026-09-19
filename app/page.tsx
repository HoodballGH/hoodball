"use client";

import { useLive } from "@/components/live/LiveProvider";
import Shell from "@/components/home/Shell";
import CountdownTimer from "@/components/home/CountdownTimer";
import JackpotCard from "@/components/home/JackpotCard";
import OddsChecker from "@/components/home/OddsChecker";
import RecentWinners from "@/components/home/RecentWinners";
import HowItWorks from "@/components/home/HowItWorks";

export default function Home() {
  const { snapshot, prelaunch } = useLive();

  return (
    <Shell>
      {!snapshot || prelaunch ? (
        <div className="prelaunch">
          <div className="spin">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/brand/ball.png" alt="" className="ball" />
          </div>
          {snapshot ? (
            <p>
              Waiting for launch… the pot opens when $HOODBALL goes live on
              Pons.
            </p>
          ) : (
            <p className="dim">Connecting…</p>
          )}
        </div>
      ) : (
        <div className="column">
          <CountdownTimer />
          <JackpotCard />
          <OddsChecker />
          <RecentWinners />
          <HowItWorks />
        </div>
      )}
    </Shell>
  );
}
