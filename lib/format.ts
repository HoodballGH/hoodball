export const short = (address: string, head = 6, tail = 4) =>
  address.length > head + tail + 2
    ? `${address.slice(0, head)}…${address.slice(-tail)}`
    : address;
export const num = (value: number | string, digits = 0) => {
  const n = typeof value === "string" ? Number(value) : value;
  return Number.isFinite(n)
    ? n.toLocaleString("en-US", { maximumFractionDigits: digits })
    : String(value);
};
export const compact = (value: number | string) => {
  const n = typeof value === "string" ? Number(value) : value;
  if (!Number.isFinite(n)) return String(value);
  if (Math.abs(n) >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (Math.abs(n) >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (Math.abs(n) >= 1e4) return `${(n / 1e3).toFixed(1)}K`;
  return n.toLocaleString("en-US", { maximumFractionDigits: n < 1 ? 4 : 2 });
};
export const amount = (value: string, max = 6) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return value;
  if (n !== 0 && Math.abs(n) < 0.000001) return "<0.000001";
  return n.toLocaleString("en-US", { maximumFractionDigits: max });
};
export function duration(seconds: number, parts = 2) {
  const s = Math.max(0, Math.floor(seconds));
  const units: [string, number][] = [
    ["d", 86400],
    ["h", 3600],
    ["m", 60],
    ["s", 1],
  ];
  const out: string[] = [];
  let rest = s;
  for (const [label, size] of units) {
    const v = Math.floor(rest / size);
    if (v > 0 || (label === "s" && !out.length)) {
      out.push(`${v}${label}`);
      rest -= v * size;
    }
    if (out.length >= parts) break;
  }
  return out.join(" ");
}
export function timeAgo(iso: string, now = Date.now()) {
  const diff = Math.max(0, Math.floor((now - new Date(iso).getTime()) / 1000));
  if (diff < 5) return "just now";
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}
export function countdown(iso: string | null, now = Date.now()) {
  if (!iso) return null;
  const diff = Math.floor((new Date(iso).getTime() - now) / 1000);
  return diff <= 0 ? "any moment" : duration(diff, 2);
}
export const isAddressLike = (value: string) =>
  /^0x[0-9a-fA-F]{40}$/.test(value.trim());
export const clock = (iso: string) =>
  new Date(iso).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
export const dateTime = (iso: string) =>
  new Date(iso).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
export function usd(value: number | null | undefined, fallback = "—") {
  if (value === null || value === undefined || !Number.isFinite(value)) return fallback;
  const n = Math.abs(value);
  const sign = value < 0 ? "-" : "";
  if (n === 0) return "$0.00";
  if (n < 0.00000001) return `${sign}<$0.00000001`;
  const digits =
    n >= 1 ? 2 : n >= 0.01 ? 4 : Math.min(8, Math.max(2, -Math.floor(Math.log10(n)) + 3));
  return `${sign}$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: digits })}`;
}
export const usdCompact = (value: number | null | undefined, fallback = "—") =>
  value === null || value === undefined || !Number.isFinite(value)
    ? fallback
    : `${value < 0 ? "-" : ""}$${compact(Math.abs(value))}`;
