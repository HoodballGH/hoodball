import { publicReadCache } from "@/lib/read-cache";
import { ensureSchema, pool } from "@/lib/db";
import { priceHistory } from "@/lib/market";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const hours = Number(params.get("hours") ?? 24);
  if (!Number.isInteger(hours) || hours <= 0 || hours > 24 * 8)
    return Response.json(
      { error: "hours must be a whole number between 1 and 192" },
      { status: 400 },
    );
  try {
    const body = await publicReadCache.get(
      JSON.stringify(["market-history", hours]),
      async () => {
        let client;
        try {
          await ensureSchema();
          client = await pool().connect();
          const points = await priceHistory(client, hours, 300);
          return { hours, count: points.length, points };
        } finally {
          client?.release();
        }
      },
    );
    return Response.json(body, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json(
      { error: "Price history is temporarily unavailable" },
      { status: 503 },
    );
  }
}
