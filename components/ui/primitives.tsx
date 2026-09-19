"use client";

import type { ReactNode } from "react";

export function Card({
  children,
  className = "",
  hoverable = false,
  round = false,
}: {
  children: ReactNode;
  className?: string;
  hoverable?: boolean;
  round?: boolean;
}) {
  return (
    <div
      className={`card${round ? " round" : ""}${hoverable ? " hoverable" : ""}${
        className ? ` ${className}` : ""
      }`}
    >
      {children}
    </div>
  );
}

export function Pill({
  tone = "",
  children,
  className = "",
}: {
  tone?: "" | "lime" | "warn" | "bad" | "muted";
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={`pill${tone ? ` ${tone}` : ""}${className ? ` ${className}` : ""}`}
    >
      {children}
    </span>
  );
}

export function Dot({ live = false }: { live?: boolean }) {
  return <span className={`dot${live ? " live" : ""}`} aria-hidden="true" />;
}

export function LimeButton({
  children,
  onClick,
  disabled,
  type = "button",
  className = "",
  title,
}: {
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  type?: "button" | "submit";
  className?: string;
  title?: string;
}) {
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`btn lime${className ? ` ${className}` : ""}`}
    >
      {children}
    </button>
  );
}

export function Stat({
  label,
  value,
  sub,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
}) {
  return (
    <div className="stat">
      <span className="label">{label}</span>
      <span className="value">{value}</span>
      {sub ? <span className="t-xs muted">{sub}</span> : null}
    </div>
  );
}

export function KeyValue({ k, v }: { k: ReactNode; v: ReactNode }) {
  return (
    <div className="kv">
      <span className="k">{k}</span>
      <span className="v">{v}</span>
    </div>
  );
}

export function RefreshIcon({ spinning = false }: { spinning?: boolean }) {
  return (
    <svg
      className={spinning ? "spin" : undefined}
      width="18"
      height="18"
      fill="none"
      stroke="currentColor"
      viewBox="0 0 24 24"
      aria-hidden="true"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
      />
    </svg>
  );
}
