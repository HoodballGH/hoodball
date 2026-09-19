import { publicReadCache } from "@/lib/read-cache";
import { ensureSchema, pool, readConfig } from "@/lib/db";
import { listDraws } from "@/lib/draws";
import { ethUsdCached } from "@/lib/prices";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const offset = Number(params.get("offset") ?? 0);
  const limit = Number(params.get("limit") ?? 25);
  if (
    !Number.isInteger(offset) ||
    offset < 0 ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 100
  )
    return Response.json({ error: "Invalid pagination; limit must be 1–100" }, { status: 400 });
  try {
    const body = await publicReadCache.get(
      JSON.stringify(["draws", offset, limit]),
      async () => {
        let client;
        try {
          await ensureSchema();
          client = await pool().connect();
          const config = await readConfig(client);
          return await listDraws(client, config, offset, limit, ethUsdCached());
        } finally {
          client?.release();
        }
      },
    );
    return Response.json(body, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json({ error: "Draw history is temporarily unavailable" }, { status: 503 });
  }
}
