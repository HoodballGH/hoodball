export const short = (address: string, head = 6, tail = 4) =>
  address.length > head + tail + 2
    ? `${address.slice(0, head)}…${address.slice(-tail)}`
    : address;

export function num(value: number | string, digits = 0) {
  const n = typeof value === "string" ? Number(value) : value;
  return Number.isFinite(n)
    ? n.toLocaleString("en-US", { maximumFractionDigits: digits })
    : "—";
}

export function eth(value: string | number | null | undefined, digits = 4) {
  if (value === null || value === undefined) return "—";
  const n = typeof value === "string" ? Number(value) : value;
  if (!Number.isFinite(n)) return "—";
  if (n !== 0 && Math.abs(n) < 0.0001) return "<0.0001";
  return n.toLocaleString("en-US", {
    minimumFractionDigits: Math.min(digits, 4),
    maximumFractionDigits: digits,
  });
}

export function usd(value: number | null | undefined, fallback = "—") {
  if (value === null || value === undefined || !Number.isFinite(value))
    return fallback;
  const n = Math.abs(value);
  const sign = value < 0 ? "-" : "";
  if (n === 0) return "$0.00";
  if (n < 0.01) return `${sign}<$0.01`;
  return `${sign}$${n.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

export function tokenAmount(value: string | null | undefined, max = 4) {
  if (value === null || value === undefined) return "—";
  const n = Number(value);
  if (!Number.isFinite(n)) return value;
  if (n !== 0 && Math.abs(n) < 0.0001) return "<0.0001";
  return n.toLocaleString("en-US", { maximumFractionDigits: max });
}

export const pct = (value: number | null | undefined, digits = 2) =>
  value === null || value === undefined || !Number.isFinite(value)
    ? "—"
    : `${value.toLocaleString("en-US", { maximumFractionDigits: digits })}%`;

export const isAddressLike = (value: string) =>
  /^0x[0-9a-fA-F]{40}$/.test(value.trim());

export const dateTime = (iso: string | null) =>
  iso
    ? new Date(iso).toLocaleString([], {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "—";

export function timeAgo(iso: string | null, now = Date.now()) {
  if (!iso) return "—";
  const diff = Math.floor((now - new Date(iso).getTime()) / 1000);
  if (diff < 0) return "in a moment";
  if (diff < 45) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

export function clockFromSeconds(totalSeconds: number) {
  const s = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(s / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  const seconds = s % 60;
  return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}
