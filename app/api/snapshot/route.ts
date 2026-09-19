import { getSnapshot } from "@/lib/snapshot";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export async function GET() {
  return Response.json(await getSnapshot(), { headers: { "Cache-Control": "no-store" } });
}
