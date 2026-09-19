import { authorized, ConfigError, updateConfig } from "@/lib/config";
import { getSnapshot, refreshSnapshot } from "@/lib/snapshot";
export const dynamic = "force-dynamic";
export async function GET() {
  return Response.json((await getSnapshot()).config, { headers: { "Cache-Control": "no-store" } });
}
export async function POST(request: Request) {
  if (!authorized(request)) return Response.json({ error: "Unauthorized" }, { status: 401 });
  if (Number(request.headers.get("content-length") ?? 0) > 32768) return Response.json({ error: "Configuration payload too large" }, { status: 413 });
  try {
    const text = await request.text();
    if (text.length > 32768) return Response.json({ error: "Configuration payload too large" }, { status: 413 });
    let payload: unknown;
    try { payload = JSON.parse(text); } catch { return Response.json({ error: "Invalid JSON" }, { status: 400 }); }
    const config = await updateConfig(payload);
    await refreshSnapshot();
    return Response.json({ config }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof ConfigError) return Response.json({ error: error.message }, { status: error.status });
    console.error("Config update failed:", error instanceof Error ? error.message : "unknown");
    return Response.json({ error: "Configuration could not be verified against the chain; no changes were applied" }, { status: 503 });
  }
}
