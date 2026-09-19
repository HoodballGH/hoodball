import { fetch as upstreamFetch } from "undici";
import { CHAIN_ID } from "./chain";
let nextId = 0;
const MAX_INFLIGHT = Math.max(1, Number(process.env.HOODBALL_RPC_CONCURRENCY ?? 6) || 6);
const MIN_SPACING_MS = Math.max(0, Number(process.env.HOODBALL_RPC_MIN_SPACING_MS ?? 25) || 0);
let inflight = 0;
let lastStart = 0;
const waiters: (() => void)[] = [];
async function acquire() {
  if (inflight >= MAX_INFLIGHT) await new Promise<void>(resolve => waiters.push(resolve));
  inflight++;
  const wait = lastStart + MIN_SPACING_MS - Date.now();
  if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
  lastStart = Date.now();
}
function release() {
  inflight--;
  waiters.shift()?.();
}
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const stats = new Map<string, { calls: number; ms: number; retries: number; http429: number }>();
function stat(method: string) {
  let entry = stats.get(method);
  if (!entry) { entry = { calls: 0, ms: 0, retries: 0, http429: 0 }; stats.set(method, entry); }
  return entry;
}
export function rpcStats() { return Object.fromEntries([...stats].map(([k, v]) => [k, { ...v, ms: Math.round(v.ms) }])); }
class RpcHttpError extends Error { constructor(public status: number) { super(`Robinhood RPC returned HTTP ${status}`); } }
export async function rpc<T>(method: string, params: unknown[] = []): Promise<T> {
  let attempt = 0;
  const entry = stat(method);
  for (;;) {
    await acquire();
    const started = performance.now();
    try {
      entry.calls++;
      return await rpcOnce<T>(method, params);
    } catch (error) {
      const status = error instanceof RpcHttpError ? error.status : 0;
      if (status === 429) entry.http429++;
      entry.retries++;
      const retryable = status === 429 || status === 502 || status === 503 || status === 504 || (error instanceof Error && /unreachable|-32005|rate limit/i.test(error.message));
      if (!retryable || attempt >= 6) throw error;
      attempt++;
      await sleep(Math.min(8000, 250 * 2 ** attempt) + Math.random() * 200);
    } finally {
      entry.ms += performance.now() - started;
      release();
    }
  }
}
async function rpcOnce<T>(method: string, params: unknown[]): Promise<T> {
  const id = ++nextId;
  let response;
  try {
    response = await upstreamFetch(process.env.ROBINHOOD_RPC_URL?.trim() || "https://rpc.mainnet.chain.robinhood.com", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
      signal: AbortSignal.timeout(15000),
    });
  } catch { throw new Error("Robinhood RPC is unreachable"); }
  if (!response.ok) throw new RpcHttpError(response.status);
  const body = await response.json() as { id?: number; jsonrpc?: string; result?: T; error?: { code?: number; message?: string } };
  if (body.id !== id || body.jsonrpc !== "2.0") throw new Error("Invalid RPC envelope");
  if (body.error) throw rpcError(method, body.error);
  if (!("result" in body)) throw new Error("RPC result missing");
  return body.result as T;
}
type BatchRequest = { method: string; params: unknown[] };
type BatchItem<T> = { id?: number; jsonrpc?: string; result?: T; error?: { code?: number; message?: string } };
const BATCH_SIZE = Math.max(1, Number(process.env.HOODBALL_RPC_BATCH_SIZE ?? 25) || 25);
let batchUnsupported = process.env.HOODBALL_RPC_BATCH === "false";
class BatchUnsupportedError extends Error {}
function rpcError(method: string, error: { code?: number; message?: string }) {
  const detail = (error.message ?? "").replace(/\s+/g, " ").slice(0, 200);
  return new Error(`Robinhood RPC rejected ${method} (${error.code ?? "unknown"}${/rate|limit|too many/i.test(error.message ?? "") ? " rate limit" : ""})${detail ? `: ${detail}` : ""}`);
}
async function batchOnce<T>(slice: BatchRequest[]): Promise<T[]> {
  const ids = slice.map(() => ++nextId);
  let response;
  try {
    response = await upstreamFetch(process.env.ROBINHOOD_RPC_URL?.trim() || "https://rpc.mainnet.chain.robinhood.com", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(slice.map((request, i) => ({ jsonrpc: "2.0", id: ids[i], method: request.method, params: request.params }))),
      signal: AbortSignal.timeout(20000),
    });
  } catch { throw new Error("Robinhood RPC is unreachable"); }
  if ([400, 404, 405, 413, 415].includes(response.status)) throw new BatchUnsupportedError();
  if (!response.ok) throw new RpcHttpError(response.status);
  const body = await response.json() as BatchItem<T>[] | BatchItem<T>;
  if (!Array.isArray(body)) throw new BatchUnsupportedError();
  if (body.length !== slice.length) throw new Error("Invalid RPC batch envelope");
  const out: T[] = new Array(slice.length);
  for (const item of body) {
    const index = ids.indexOf(item.id ?? -1);
    if (index < 0 || item.jsonrpc !== "2.0") throw new Error("Invalid RPC batch envelope");
    if (item.error) throw rpcError(slice[index].method, item.error);
    if (!("result" in item)) throw new Error("RPC result missing");
    out[index] = item.result as T;
  }
  return out;
}
export async function rpcBatch<T>(requests: BatchRequest[]): Promise<T[]> {
  const out: T[] = new Array(requests.length);
  for (let offset = 0; offset < requests.length; offset += BATCH_SIZE) {
    const slice = requests.slice(offset, offset + BATCH_SIZE);
    let results: T[] | undefined;
    let attempt = 0;
    const entry = stat(`batch:${slice[0].method}`);
    while (!batchUnsupported && !results) {
      await acquire();
      const started = performance.now();
      try {
        entry.calls++;
        results = await batchOnce<T>(slice);
      } catch (error) {
        if (error instanceof BatchUnsupportedError) { batchUnsupported = true; break; }
        const status = error instanceof RpcHttpError ? error.status : 0;
        if (status === 429) entry.http429++;
        entry.retries++;
        const retryable = status === 429 || status === 502 || status === 503 || status === 504 || (error instanceof Error && /unreachable|-32005|rate limit/i.test(error.message));
        if (!retryable || attempt >= 6) throw error;
        attempt++;
        await sleep(Math.min(8000, 250 * 2 ** attempt) + Math.random() * 200);
      } finally {
        entry.ms += performance.now() - started;
        release();
      }
    }
    if (!results) results = await Promise.all(slice.map(request => rpc<T>(request.method, request.params)));
    for (let i = 0; i < results.length; i++) out[offset + i] = results[i];
  }
  return out;
}
export async function externalFetch(url: string, init: { headers?: Record<string, string>; timeoutMs?: number } = {}) {
  return upstreamFetch(url, { method: "GET", headers: init.headers, signal: AbortSignal.timeout(init.timeoutMs ?? 10000) });
}
export async function assertChain() {
  if (BigInt(await rpc<string>("eth_chainId")) !== BigInt(CHAIN_ID)) throw new Error("RPC chain mismatch; expected Robinhood Chain 4663");
}
export function blockTag(n: number) {
  if (!Number.isSafeInteger(n) || n < 0) throw new Error("Invalid block number");
  return `0x${n.toString(16)}`;
}
export function rpcNumber(hex: string): number {
  if (!/^0x[0-9a-f]+$/i.test(hex)) throw new Error("Invalid RPC quantity");
  const value = Number(BigInt(hex));
  if (!Number.isSafeInteger(value)) throw new Error("RPC quantity exceeds safe integer");
  return value;
}
