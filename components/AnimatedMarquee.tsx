"use client";

import { memo } from "react";
import Marquee from "react-fast-marquee";

const LINE = (
  <>
    Hoodball is a fully automated holder lottery built on&nbsp;
    <a href="https://pons.fun" target="_blank" rel="noreferrer">
      Pons V2
    </a>
    &nbsp;on Robinhood Chain. Everyone holding $HOODBALL is automatically in the
    draw, weighted pro rata: hold 2× more, win 2× as often. Liquidity pools,
    contracts and the vault are never eligible. Fully transparent, verifiable
    and fair. Happy hooding!&nbsp;&nbsp;
  </>
);

function AnimatedMarquee() {
  return (
    <div className="marquee">
      <Marquee speed={100}>
        {LINE}
        {LINE}
      </Marquee>
    </div>
  );
}

export default memo(AnimatedMarquee);
