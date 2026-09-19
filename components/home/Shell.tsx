"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import Nav from "./Nav";
import TopBar from "./TopBar";
import StatusLine from "./StatusLine";

export default function Shell({
  children,
  compact = false,
}: {
  children: ReactNode;
  compact?: boolean;
}) {
  return (
    <main className="page">
      <div className="glow" aria-hidden="true" />
      <TopBar />
      <div className="page-inner">
        <div className="column">
          <Nav />
        </div>

        <div className={`logo-wrap${compact ? " compact" : ""}`}>
          <Link href="/" prefetch={false} aria-label="Hoodball home">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/brand/logo.png" alt="Hoodball" className="logo" />
          </Link>
        </div>

        {children}

        <StatusLine />
      </div>
    </main>
  );
}
