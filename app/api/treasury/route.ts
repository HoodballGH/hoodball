import { publicReadCache } from "@/lib/read-cache";
import { ensureSchema, pool } from "@/lib/db";
import { listTreasuryOps } from "@/lib/treasury";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const offset = Number(params.get("offset") ?? 0); const limit = Number(params.get("limit") ?? 25);
  if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 250) return Response.json({ error: "Invalid pagination; limit must be 1–250" }, { status: 400 });
  try {
    const body = await publicReadCache.get(JSON.stringify(["treasury", offset, limit]), async () => {
      let client;
      try { await ensureSchema(); client = await pool().connect(); return await listTreasuryOps(client, offset, limit); }
      finally { client?.release(); }
    });
    return Response.json(body, { headers: { "Cache-Control": "no-store" } });
  } catch { return Response.json({ error: "Treasury history is temporarily unavailable" }, { status: 503 }); }
}
