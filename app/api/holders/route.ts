import { isAddress } from "viem";
import { getHolders } from "@/lib/snapshot";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  const url = new URL(request.url);
  const address = url.searchParams.get("address");
  if (address && !isAddress(address, { strict: false })) return Response.json({ error: "Invalid wallet address" }, { status: 400 });
  const offset = Number(url.searchParams.get("offset") ?? 0);
  const limit = Number(url.searchParams.get("limit") ?? 100);
  if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 250) return Response.json({ error: "Invalid pagination; limit must be 1–250" }, { status: 400 });
  return Response.json(await getHolders(address, offset, limit), { headers: { "Cache-Control": "no-store" } });
}
