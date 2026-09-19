"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { Snapshot } from "@/lib/types";

type LiveState = {
  snapshot: Snapshot | null;
  connected: boolean;
  error: boolean;
  now: number;
  serverOffset: number;
  prelaunch: boolean;
  explorer: string;
  refresh: () => void;
};

const LiveContext = createContext<LiveState | null>(null);
const DEFAULT_EXPLORER = "https://robinhoodchain.blockscout.com";

const offsetOf = (snapshot: Snapshot | null) => {
  const serverTime = snapshot?.serverTime ?? snapshot?.updatedAt;
  if (!serverTime) return 0;
  const parsed = new Date(serverTime).getTime();
  return Number.isFinite(parsed) ? parsed - Date.now() : 0;
};

export function LiveProvider({
  children,
  initial = null,
}: {
  children: ReactNode;
  initial?: Snapshot | null;
}) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(initial);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState(false);
  const [now, setNow] = useState(() =>
    initial ? new Date(initial.updatedAt).getTime() : Date.now(),
  );
  const [serverOffset, setServerOffset] = useState(0);
  const refreshRef = useRef<() => void>(() => {});

  useEffect(() => {
    let active = true;
    const apply = (data: Snapshot) => {
      if (!active || !data?.config || !data?.chain) return;
      setSnapshot(data);
      setServerOffset(offsetOf(data));
      setError(false);
    };
    const refresh = () => {
      const started = Date.now();
      return fetch("/api/snapshot", { cache: "no-store" })
        .then((r) => {
          if (!r.ok) throw new Error("unavailable");
          return r.json() as Promise<Snapshot>;
        })
        .then((data) => {
          const latency = (Date.now() - started) / 2;
          apply(data);
          const serverTime = data.serverTime ?? data.updatedAt;
          const parsed = serverTime ? new Date(serverTime).getTime() : NaN;
          if (Number.isFinite(parsed))
            setServerOffset(parsed + latency - Date.now());
        })
        .catch(() => {
          if (active) setError(true);
        });
    };
    refreshRef.current = () => void refresh();
    void refresh();

    const source = new EventSource("/api/events");
    source.onopen = () => setConnected(true);
    source.onerror = () => setConnected(false);
    source.addEventListener("snapshot", (event: MessageEvent) => {
      try {
        apply(JSON.parse(event.data) as Snapshot);
        setConnected(true);
      } catch {
        setError(true);
      }
    });

    const fallback = window.setInterval(() => {
      if (source.readyState !== EventSource.OPEN) void refresh();
    }, 15000);
    const firstTick = window.setTimeout(() => setNow(Date.now()), 0);
    const tick = window.setInterval(() => setNow(Date.now()), 1000);
    return () => {
      active = false;
      source.close();
      window.clearInterval(fallback);
      window.clearTimeout(firstTick);
      window.clearInterval(tick);
    };
  }, []);

  const refresh = useCallback(() => refreshRef.current(), []);

  const value = useMemo<LiveState>(() => {
    return {
      snapshot,
      connected,
      error,
      now,
      serverOffset,
      prelaunch: !snapshot?.config.tokenAddress,
      explorer: snapshot?.chain.explorerUrl || DEFAULT_EXPLORER,
      refresh,
    };
  }, [snapshot, connected, error, now, serverOffset, refresh]);

  return <LiveContext.Provider value={value}>{children}</LiveContext.Provider>;
}

export function useLive() {
  const value = useContext(LiveContext);
  if (!value) throw new Error("useLive must be used inside LiveProvider");
  return value;
}
