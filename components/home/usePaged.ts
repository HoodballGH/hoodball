"use client";

import { useEffect, useState } from "react";

const ITEM_KEYS = ["items", "draws", "holders", "rows"];

const pickItems = <T>(body: Record<string, unknown>): T[] => {
  for (const key of ITEM_KEYS) {
    const value = body[key];
    if (Array.isArray(value)) return value as T[];
  }
  return [];
};

type State<T> = {
  items: T[];
  total: number;
  loadedOffset: number;
  error: boolean;
};

export function usePaged<T>(path: string, limit: number) {
  const [offset, setOffset] = useState(0);
  const [nonce, setNonce] = useState(0);
  const [state, setState] = useState<State<T>>({
    items: [],
    total: 0,
    loadedOffset: -1,
    error: false,
  });

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      try {
        const res = await fetch(`${path}?offset=${offset}&limit=${limit}`, {
          cache: "no-store",
        });
        if (!res.ok) throw new Error("unavailable");
        const body = (await res.json()) as Record<string, unknown>;
        if (cancelled) return;
        setState({
          items: pickItems<T>(body),
          total: Number(body.total ?? 0),
          loadedOffset: offset,
          error: false,
        });
      } catch {
        if (!cancelled)
          setState((prev) => ({ ...prev, loadedOffset: offset, error: true }));
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [path, limit, offset, nonce]);

  return {
    items: state.items,
    total: state.total,
    error: state.error,
    loading: state.loadedOffset !== offset,
    offset,
    limit,
    setOffset,
    reload: () => setNonce((n) => n + 1),
  };
}
