import { isAddress } from "viem";
import { getOdds } from "@/lib/snapshot";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  const address = new URL(request.url).searchParams.get("address");
  if (!address || !isAddress(address, { strict: false }))
    return Response.json({ error: "A wallet address is required" }, { status: 400 });
  try {
    return Response.json(await getOdds(address), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch {
    return Response.json({ error: "Odds are temporarily unavailable" }, { status: 503 });
  }
}
